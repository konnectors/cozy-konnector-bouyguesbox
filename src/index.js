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
  //  debug: true,
  cheerio: false,
  json: true,
  jar: true
})

module.exports = new BaseKonnector(async function fetch(fields) {
  const baseUrl = 'https://api.bouyguestelecom.fr'
  const idPersonne = await logIn(fields)

  const personnes = await rq(`${baseUrl}/personnes/${idPersonne}`)
  const linkFactures = personnes._links.factures.href
  const comptes = (await rq(`${baseUrl}${linkFactures}`)).comptesFacturation

  for (let compte of comptes) {
    for (let facture of compte.factures) {
      // Fetch the facture url to get a json containing the definitive pdf url
      const result = await rq(`${baseUrl}${facture._links.facturePDF.href}`)
      const factureUrl = `${baseUrl}${result._actions.telecharger.action}`
      // Call each time because of quick link expiration (~1min)
      await saveBills(
        [
          {
            vendor: 'Bouygues Box',
            date: new Date(facture.dateFacturation),
            amount: facture.mntTotFacture,
            fileurl: factureUrl,
            filename: getFileName(facture.dateFacturation)
          }
        ],
        fields,
        {
          identifiers: 'bouyg'
        }
      )
    }
  }
})

// Procedure to login to Bouygues website.
async function logIn({ login, password }) {
  await signin({
    url: 'https://www.mon-compte.bouyguestelecom.fr/cas/login',
    formSelector: 'form',
    formData: { username: login, password }
  })
  // Acredite token for downloading file via the API
  const resp = await rq(
    'https://oauth2.bouyguestelecom.fr/authorize?client_id=a360.bouyguestelecom.fr&response_type=id_token%20token&redirect_uri=https%3A%2F%2Fwww.bouyguestelecom.fr%2Fmon-compte%2F',
    {
      resolveWithFullResponse: true
    }
  )

  const href = resp.request.uri.href.split('=')
  const accessToken = href[1].split('&')[0]
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
