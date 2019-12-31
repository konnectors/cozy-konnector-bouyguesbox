// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://0377c20d30914b9288eac18b6d8bbd26:25133595ed4d4e47aa32b4dbfcd89f6b@sentry.cozycloud.cc/22'

const moment = require('moment')
const jwt = require('jwt-decode')

const {
  BaseKonnector,
  requestFactory,
  log,
  signin,
  cozyClient
} = require('cozy-konnector-libs')

const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

module.exports = new BaseKonnector(async function fetch(fields) {
  if (!fields.lastname) {
    log('debug', 'Name not set, auth could fail trough some IP')
  }
  const baseUrl = 'https://api.bouyguestelecom.fr'
  const { idPersonne, accessToken } = await logIn(fields)
  log('info', 'Login succeed')

  const authRequest = request.defaults({
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  const personnes = await authRequest(`${baseUrl}/personnes/${idPersonne}`)
  const linkFactures = personnes._links.factures.href
  const comptes = await authRequest(`${baseUrl}${linkFactures}`)
  log('warn', `${comptes.comptesFacturation.length} comptes found`)
  let comptesWithBills = 0
  for (const compte of comptes.comptesFacturation) {
    if (compte.factures.length > 0) {
      comptesWithBills += 1
    }
  }
  log('warn', `${comptesWithBills} comptes with bills`)
  if (comptesWithBills > 1) {
    log('warn', 'MultiContrats')
  }
  // Needed to find line type in contract with the ids found in comptes
  const contratsSignes = await authRequest(
    `${baseUrl}/personnes/${idPersonne}/contrats-signes`
  )
  log('warn', `${contratsSignes.items.length} contracts found`)

  // Try extracting Name of personnes object
  if (fields.lastname) {
    log('debug', 'Lastname already set, do nothing')
  } else {
    log('debug', 'Extracting lastame from website')
    const name = tryNameExtraction(personnes)
    log('debug', 'Setting lastname in account')
    try {
      setName(name, this.accountId)
    } catch (e) {
      log('warn', 'Error when setting account')
      log('warn', e.msg ? e.msg : e)
    }
  }

  for (let compte of comptes.comptesFacturation) {
    const ligneType = findLigneType(compte.id, contratsSignes)
    if (ligneType === 'FIXE') {
      log('debug', `${compte.factures.length} bills found for ${ligneType}`)
      for (let facture of compte.factures) {
        // Fetch the facture url to get a json containing the definitive pdf url
        // If facturePDF is not define, it seems facturePDFDF is ok
        let result
        if (facture._links.facturePDF !== undefined) {
          result = await authRequest(
            `${baseUrl}${facture._links.facturePDF.href}`
          )
        } else {
          result = await authRequest(
            `${baseUrl}${facture._links.facturePDFDF.href}`
          )
        }
        const factureUrl = `${baseUrl}${result._actions.telecharger.action}`
        // Call each time because of quick link expiration (~1min)
        await this.saveBills(
          [
            {
              vendor: 'Bouygues Box',
              date: new Date(facture.dateFacturation),
              amount: facture.mntTotFacture,
              fileurl: factureUrl,
              filename: getFileName(facture.dateFacturation),
              currency: '€',
              metadata: {
                importDate: new Date(),
                version: 1
              },
              fileAttributes: {
                metadata: {
                  classification: 'invoicing',
                  datetime: new Date(facture.dateFacturation),
                  datetimeLabel: 'issueDate',
                  contentAuthor: 'bouygues',
                  subClassification: 'invoice',
                  categories: ['isp'],
                  issueDate: new Date(facture.dateFacturation),
                  invoiceNumber: facture.idFacture,
                  contractReference: compte.id,
                  isSubscription: true
                }
              }
            }
          ],
          fields,
          {
            identifiers: 'bouyg',
            sourceAccount: this.accountId,
            sourceAccountIdentifier: fields.login
          }
        )
      }
      // End of first account fetched, we exit here to limit to 1 account
      break
    }
  }
  // Evalutate all comptes type
  for (let compte of comptes.comptesFacturation) {
    findLigneType(compte.id, contratsSignes)
  }
})

// Procedure to login to Bouygues website.
async function logIn({ login, password, lastname }) {
  await signin({
    url: 'https://www.mon-compte.bouyguestelecom.fr/cas/login',
    formSelector: 'form',
    formData: { username: login, password, lastname },
    simple: false,
    validate: (statusCode, $) => {
      if (
        $.html().includes(
          'Votre identifiant ou votre mot de passe est incorrect'
        )
      ) {
        return false
      } else {
        return true
      }
    }
  })
  log('debug', `First login succeed, asking for more API rights`)
  // Acredite token for downloading file via the API
  const resp = await request(
    'https://oauth2.bouyguestelecom.fr/authorize?client_id=a360.bouyguestelecom.fr&response_type=id_token%20token&redirect_uri=https%3A%2F%2Fwww.bouyguestelecom.fr%2Fmon-compte%2F',
    {
      resolveWithFullResponse: true
    }
  )
  log('debug', `Returned http code ${resp.statusCode}`)
  log('debug', 'Extracting token from request')
  if (resp.request.uri.href.includes('https://oauth2.bouyguestelecom')) {
    log('error', 'Api right enhancement failed, redirect to auth')
    throw new Error('LOGIN_FAILED.NEEDS_SECRET')
  } else {
    const href = resp.request.uri.href.split('=')
    const accessToken = href[1].split('&')[0]
    // Better extraction than split because base64 include some =
    log('debug', 'Extracting personne from jsonwebtoken jwt')
    const jwtString = resp.request.uri.href.match(/id_token=(.*)$/)[1]
    const idPersonne = jwt(jwtString).id_personne
    return { idPersonne, accessToken }
  }
}

function findLigneType(idCompte, contrats) {
  for (let contrat of contrats.items) {
    if (contrat._links.compteFacturation.href.includes(idCompte)) {
      log('debug', `One 'compteFacturation' detected as ${contrat.typeLigne}`)
      // LigneType known : FIXE or MOBILE
      if (contrat.typeLigne != 'FIXE' && contrat.typeLigne != 'MOBILE') {
        log('warn', `Unknown LigneType ${contrat.typeLigne}`)
      }
      return contrat.typeLigne
    }
  }
  // Else not found at all
  log('warn', 'LigneType not detected')
  return undefined
}

function getFileName(date) {
  return `${moment(date).format('YYYYMM')}_bouyguesBox.pdf`
}

function tryNameExtraction(personnes) {
  if (personnes.nom.length > 0) {
    return personnes.nom
  } else {
    log('warn', 'Name seems empty, impossible to set')
  }
}

async function setName(name, accountId) {
  let accountObj = await cozyClient.data.find('io.cozy.accounts', accountId)
  accountObj.auth.lastname = name
  await cozyClient.data.update('io.cozy.accounts', accountObj, accountObj)
}
