/** Anything wrong with a query: an unknown column, a misplaced aggregate, a bad table. */
export class SqlError extends Error {
  constructor (message, details) {
    super(message)
    this.name = 'SqlError'
    if (details) Object.assign(this, details)
  }
}

/** The query text does not parse. Carries `location` ({ start, end } with offset/line/column). */
export class SqlSyntaxError extends SqlError {
  constructor (message, location) {
    super(message, { location })
    this.name = 'SqlSyntaxError'
  }
}
