export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Ids from URLs and bodies are checked before a query, since a uuid column rejects anything else with an error
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
