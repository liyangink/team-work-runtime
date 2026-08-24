const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export class DomainError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.details = details
  }
}

export function assertIdentifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a stable lowercase identifier`)
  }
  return value
}

export function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a lowercase sha256 digest`)
  }
  return value
}

export function assertTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be an ISO timestamp`)
  }
  return value
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a non-empty string`)
  }
  return value
}

export function assertUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value === "")) {
    throw new DomainError("DOMAIN_INVALID", `${label} must contain non-empty strings`)
  }
  if (new Set(values).size !== values.length) {
    throw new DomainError("DOMAIN_INVALID", `${label} must not contain duplicates`)
  }
  return values
}

export function assertStringList(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.some((value) => typeof value !== "string" || value === "")) {
    throw new DomainError("DOMAIN_INVALID", `${label} must contain non-empty strings`)
  }
  if (new Set(values).size !== values.length) {
    throw new DomainError("DOMAIN_INVALID", `${label} must not contain duplicates`)
  }
  return values
}
