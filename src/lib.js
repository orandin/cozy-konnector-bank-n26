const {
  updateOrCreate,
  log,
  categorize,
  errors,
  cozyClient
} = require('cozy-konnector-libs')

const n26 = require('n26')
const moment = require('moment')

const doctypes = require('cozy-doctypes')
const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

// ------

BankAccount.registerClient(cozyClient)
BalanceHistory.registerClient(cozyClient)
Document.registerClient(cozyClient)

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

let lib

/**
 * The start function is run by the BaseKonnector instance only when it got all the account
 * information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
 * the account information come from ./konnector-dev-config.json file
 * @param {object} fields
 */
async function start(fields) {
  let client            = null;
  let account           = null;
  let transactionsList  = [];

  log('info', 'Authenticating ...')
  try {
    client = await new n26(fields.login, fields.password)
  } catch(err) {
    log('error', err)
    throw new Error((err.status >= 500) ? errors.VENDOR_DOWN : errors.LOGIN_FAILED)
  }
  log('info', 'Successfully logged in')

  try {
    account = await client.account()
    transactionsList = await client.transactions()
  } catch {
    log('error', err)
    throw new Error(errors.VENDOR_DOWN)
  }

  log('info', 'Get bank account')
  const bankAccount = lib.parseBankAccounts(account)

  log('info', 'Retrieve all informations for each bank accounts found')
  let allOperations = lib.parseOperations(bankAccount, transactionsList)

  log('info', 'Categorize the list of transactions')
  const categorizedTransactions = await categorize(allOperations)

  const { accounts: savedAccounts } = await reconciliator.save([bankAccount], categorizedTransactions)

  log(
    'info',
    'Retrieve the balance histories and adds the balance of the day for each bank accounts'
  )
  const balances = await fetchBalances(savedAccounts)

  log('info', 'Save the balance histories')
  await lib.saveBalances(balances)
}

/**
 * Converts the JSON response to io.cozy.bank.accounts
 *
 * @param {object} json response of n26.account()
 * @see {@link https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape}
 *
 * @example
 * parseBankAccounts(json);
 *
 * // {
 * //   institutionLabel: 'N26 Bank',
 * //   label: 'COMPTE COURANT',
 * //   type: 'Checkings',
 * //   balance: 42,
 * //   number: '0042...',
 * //   rawNumber: '0042...',
 * //   vendorId: '0042...'
 * // }
 *
 * @returns {object}
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 */
function parseBankAccounts(json) {
  // Get number of bank account from IBAN
  const number = json.iban.slice(-13, -2)

  return {
    institutionLabel: json.bankName,
    label: 'COMPTE COURANT',
    type: 'Checkings',
    balance: json.bankBalance,
    number,
    rawNumber: number,
    vendorId: json.id
  }
}

/**
 * Parses and transforms each lines (JSON format) into
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}
 * @param {io.cozy.bank.accounts} account Bank account
 * @param {array} operationLines Lines containing operation information for the current bank account - CSV format expected
 *
 * @example
 * var account = {
 *    institutionLabel: 'N26 Bank',
 *    label: 'COMPTE COURANT',
 *    type: 'Checkings',
 *    balance: 42,
 *    number: '0042...',
 *    rawNumber: '0042...',
 *    vendorId: '0042...'
 * };
 *
 * var transactionsList = [
 *    {
 *      referenceText: 'VIR',
 *      currencyCode: 'EUR',
 *      ...
 *    }
 * ];
 *
 * parseOperations(account, transactionsList);
 * // [
 * //   {
 * //     label: 'VIR',
 * //     type: 'direct debit',
 * //     cozyCategoryId: '200130',
 * //     cozyCategoryProba: 1,
 * //     date: "2018-12-30T23:00:00+01:00",
 * //     dateOperation: "2018-12-31T23:00:00+01:00",
 * //     dateImport: "2019-04-17T10:07:30.553Z",     (UTC)
 * //     currency: 'EUR',
 * //     vendorAccountId: 'XXXXXXXX',
 * //     amount: 38.67,
 * //     vendorId: 'XXXXXXXX_2018-12-30_0'           {number}_{date}_{index}
 * //   }
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}.
 */
function parseOperations(account, transactionsList) {
  return transactionsList.map(transaction => {
    return {
      label: transaction.referenceText,
      type: 'none',
      date: moment(transaction.confirmed).format(),
      dateOperation: moment(transaction.confirmed).format(),
      dateImport: new Date().toISOString(),
      currency: transaction.currencyCode,
      vendorAccountId: account.vendorId,
      amount: transaction.amount,
      vendorId: transaction.id
    }
  })
}

/**
 * Retrieves the balance histories of each bank accounts and adds the balance of the day for each bank account.
 * @param {array} accounts Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * already registered in database
 *
 * @example
 * var accounts = [
 *    {
 *      _id: '12345...',
 *      _rev: '14-98765...',
 *      _type: 'io.cozy.bank.accounts',
 *      balance: 42,
 *      cozyMetadata: { updatedAt: '2019-04-17T10:07:30.769Z' },
 *      institutionLabel: 'N26 Bank',
 *      label: 'COMPTE COURANT',
 *      number: 'XXXXXXXX',
 *      rawNumber: 'XXXXXXXX',
 *      type: 'Checkings',
 *      vendorId: 'XXXXXXXX'
 *    }
 * ];
 *
 *
 * fetchBalances(accounts);
 *
 * // [
 * //   {
 * //     _id: '12345...',
 * //     _rev: '9-98765...',
 * //     balances: { '2019-04-16': 42, '2019-04-17': 42 },
 * //     metadata: { version: 1 },
 * //     relationships: { account: [Object] },
 * //     year: 2019
 * //   }
 * // ]
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * registered in database
 */
function fetchBalances(accounts) {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await BalanceHistory.getByYearAndAccount(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

/**
 * Saves the balance histories in database.
 *
 * @param balances Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * to save in database
 * @returns {Promise}
 */
function saveBalances(balances) {
  return updateOrCreate(balances,  BalanceHistory.doctype, ['_id'])
}

// ===== Export ======

String.prototype.replaceAll = function(search, replacement) {
  var target = this
  return target.replace(new RegExp(search, 'g'), replacement)
}

module.exports = lib = {
  start,
  parseBankAccounts,
  parseOperations,
  fetchBalances,
  saveBalances
}
