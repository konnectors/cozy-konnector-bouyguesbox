// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://0377c20d30914b9288eac18b6d8bbd26:25133595ed4d4e47aa32b4dbfcd89f6b@sentry.cozycloud.cc/22'

const moment = require('moment')
const jwt = require('jwt-decode')

const {
  BaseKonnector,
  saveBills,
  requestFactory,
  signin
} = require('cozy-konnector-libs')

let rq = requestFactory({
  debug: true,
  cheerio: false,
  json: true,
  jar: true
})

let accessToken

module.exports = new BaseKonnector(async function fetch(fields) {
  const baseUrl = 'https://api.bouyguestelecom.fr'
  const idPersonne = await logIn(fields)

  const personnes = await rq(`${baseUrl}/personnes/${idPersonne}`)
  const linkFactures = personnes._links.factures.href
  const comptes = (await rq(`${baseUrl}${linkFactures}`)).comptesFacturation

  const bills = []
  for (let compte of comptes) {
    for (let facture of compte.factures) {
      // FIXME the failing request
      // const result = await rq(`${baseUrl}${facture._links.facturePDF.href}`)
      bills.push({
        vendor: 'Bouygues Box',
        date: new Date(facture.dateFacturation),
        amount: facture.mntTotFacture,
        fileurl: `${baseUrl}${facture._links.facturePDF.href}`,
        filename: getFileName(facture.dateFacturation)
      })
    }
  }

  return saveBills(bills, fields, {
    identifiers: 'bouyg'
  })
})

// Procedure to login to Bouygues website.
async function logIn({ login, password }) {
  await signin({
    url: 'https://www.mon-compte.bouyguestelecom.fr/cas/login',
    formSelector: 'form',
    formData: { username: login, password }
  })

  const resp = await rq(
    'https://oauth2.bouyguestelecom.fr/authorize?client_id=ec.nav.bouyguestelecom.fr&response_type=id_token%20token&redirect_uri=https%3A%2F%2Fwww.bouyguestelecom.fr%2Fstatic%2Fhfc%2Fcallback.html&prompt=none',
    {
      resolveWithFullResponse: true
    }
  )

  const href = resp.request.uri.href.split('=')
  accessToken = href[1].split('&')[0]

  rq = rq.defaults({
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  const idPersonne = jwt(href.pop()).id_personne
  return idPersonne
}

function getFileName(date) {
  return `${moment(date).format('YYYYMM')}_bouyguesBox.pdf`
}
