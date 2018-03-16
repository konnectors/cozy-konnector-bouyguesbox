'use strict'

const qs = require('querystring')
const moment = require('moment')

const {
  log,
  BaseKonnector,
  saveBills,
  request
} = require('cozy-konnector-libs')

let rq = request({
  cheerio: true,
  json: false,
  jar: true,
  // debug: true,
  headers: {}
})

module.exports = new BaseKonnector(function fetch(fields) {
  return logIn(fields)
    .then(parsePage)
    .then(entries =>
      saveBills(entries, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers: 'bouyg'
      })
    )
    .catch(err => {
      // Connector is not in error if there is not entry in the end
      // It may be simply an empty account
      if (err.message === 'NO_ENTRY') return []
      throw err
    })
})

// Procedure to login to Bouygues website.
function logIn(fields) {
  const loginUrl = 'https://www.mon-compte.bouyguestelecom.fr/cas/login'
  const billUrl =
    'https://www.bouyguestelecom.fr/parcours/mes-factures/historique'

  log('info', 'Logging in on Bouygues Website...')
  return rq(loginUrl)
    .then($ => {
      // Extract hidden values
      const lt = $('input[name="lt"]').val()
      const execution = $('input[name="execution"]').val()

      // Second request to log in (post the form).
      const form = {
        username: fields.login,
        password: fields.password,
        lt: lt,
        execution: execution,
        _eventId: 'submit'
      }

      const loginOptions = {
        method: 'POST',
        form,
        uri: loginUrl
      }
      return rq(loginOptions)
    })
    .then($ => {
      log('info', 'Successfully logged in.')
      const badLogin = $('.error-icon').length > 0
      if (badLogin) {
        throw new Error('LOGIN_FAILED')
      }

      const $txtindispo = $('.txt-indispo')
      if ($txtindispo.length) {
        log(
          'error',
          $txtindispo
            .text()
            .trim()
            .replace(/\n/g, ' ')
            .replace(/ */, ' ')
        )
        throw new Error('VENDOR_DOWN')
      }
    })
    .then(() => {
      log('info', 'Download bill HTML page...')
      return rq(billUrl)
    })
}

// Procedure to extract bill data from the page.
function parsePage($) {
  let baseDlUrl =
    'https://www.bouyguestelecom.fr/parcours/facture/download/index'
  const entries = []
  moment.locale('fr')

  // We browse the bills table by processing each line one by one.
  $('.download-facture').each(function() {
    // Markup is not clean, we grab the date from the tag text.
    let date = $(this)
      .text()
      .trim()
      .split(' ')
      .splice(0, 2)
      .join(' ')
      .trim()

    // Amount is in a dirty field. We work on the tag text to extract data.
    let amount = $(this)
      .find('.small-prix')
      .text()
      .trim()
    amount = parseFloat(amount.replace('€', ',').replace(',', '.'))

    // Get the facture id and build the download url from it.
    const id = $(this).attr('facture-id')
    const params = { id }
    const fileurl = `${baseDlUrl}?${qs.stringify(params)}`
    date = moment(date, 'MMMM YYYY').add(14, 'days')

    // Build bill object.
    const bill = {
      vendor: 'Bouygues Box',
      date: date.toDate(),
      amount,
      fileurl,
      filename: getFileName(date)
    }
    entries.push(bill)
  })

  log('info', 'Bill data parsed.')

  return Promise.resolve(entries)
}

function getFileName(date) {
  return `${date.format('YYYYMM')}_bouyguesBox.pdf`
}
