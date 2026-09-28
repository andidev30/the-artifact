// A failure to report as is, with no stack: a message from the server, or one of ours
export class CliError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// The command line itself is wrong; exits 2, like most tools
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2)
  }
}

// The server refused the token (401), after any refresh
export class SignedOutError extends CliError {}
