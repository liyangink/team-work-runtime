export class StoreError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.name = "StoreError"
    this.code = code
    this.details = details
  }
}

