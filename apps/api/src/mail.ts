import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer'
import { env, mailEnabled } from './env.js'

export class MailDisabledError extends Error {
  constructor() {
    super('Email is not set up on this server (SMTP_HOST is empty).')
  }
}

let smtp: Transporter | null = null

// Every send fails with MailDisabledError when SMTP isn't configured; callers fall back to a link
export const transport = {
  async sendMail(message: SendMailOptions) {
    if (!mailEnabled()) throw new MailDisabledError()
    smtp ??= nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    })
    return smtp.sendMail(message)
  },
}

export async function sendSignInLink(to: string, link: string, intent: 'login' | 'signup') {
  const action = intent === 'signup' ? 'create your account' : 'log in'
  const subject = intent === 'signup' ? 'Finish creating your account on The Artifact' : 'Your sign-in link for The Artifact'

  await transport.sendMail({
    from: env.smtp.from,
    to,
    subject,
    text: `Open this link to ${action} on The Artifact:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #1c2b4b; max-width: 480px">
        <p style="font-size: 16px">Open this link to ${action} on The Artifact.</p>
        <p>
          <a href="${link}" style="display: inline-block; padding: 12px 20px; background: #ffe066; color: #1c2b4b; border: 1.5px solid #1c2b4b; border-radius: 3px; font-weight: 700; text-decoration: none">
            ${intent === 'signup' ? 'Create my account' : 'Log in'}
          </a>
        </p>
        <p style="font-size: 14px; color: #4a587a">The link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>
      </div>`,
  })
}

type ShareNotice = { from: string; title: string; link: string; role: 'viewer' | 'editor'; message?: string }

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

export async function sendShareNotice(to: string, n: ShareNotice) {
  const can = n.role === 'editor' ? 'view and edit' : 'view'
  await transport.sendMail({
    from: env.smtp.from,
    to,
    subject: `${n.from} shared "${n.title}" with you`,
    text: `${n.from} shared a page with you on The Artifact. You can ${can} it.\n\n${n.message ? `"${n.message}"\n\n` : ''}${n.title}\n${n.link}\n\nIf you don't have an account yet, sign up with this email address to open it.`,
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #1c2b4b; max-width: 480px">
        <p style="font-size: 16px"><strong>${escapeHtml(n.from)}</strong> shared a page with you. You can ${can} it.</p>
        ${n.message ? `<p style="padding: 10px 14px; background: #f5f7fb; border-left: 3px solid #1c2b4b">${escapeHtml(n.message)}</p>` : ''}
        <p>
          <a href="${n.link}" style="display: inline-block; padding: 12px 20px; background: #ffe066; color: #1c2b4b; border: 1.5px solid #1c2b4b; border-radius: 3px; font-weight: 700; text-decoration: none">
            Open "${escapeHtml(n.title)}"
          </a>
        </p>
        <p style="font-size: 14px; color: #4a587a">If you don't have an account yet, sign up with this email address to open it.</p>
      </div>`,
  })
}

type InvitationNotice = { from: string; organization: string; role: 'admin' | 'member'; link: string; expiresInDays: number }

export async function sendInvitation(to: string, n: InvitationNotice) {
  const as = n.role === 'admin' ? 'an admin' : 'a member'
  await transport.sendMail({
    from: env.smtp.from,
    to,
    subject: `${n.from} invited you to ${n.organization} on The Artifact`,
    text: `${n.from} invited you to join ${n.organization} on The Artifact as ${as}. You will see the pages your team's agents publish.\n\nAccept the invitation:\n${n.link}\n\nLog in or sign up with ${to} to accept. The invitation expires in ${n.expiresInDays} days.`,
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #1c2b4b; max-width: 480px">
        <p style="font-size: 16px"><strong>${escapeHtml(n.from)}</strong> invited you to join <strong>${escapeHtml(n.organization)}</strong> on The Artifact as ${as}.</p>
        <p style="font-size: 14px; color: #4a587a">You will see the pages your team's agents publish.</p>
        <p>
          <a href="${n.link}" style="display: inline-block; padding: 12px 20px; background: #ffe066; color: #1c2b4b; border: 1.5px solid #1c2b4b; border-radius: 3px; font-weight: 700; text-decoration: none">
            Accept invitation
          </a>
        </p>
        <p style="font-size: 14px; color: #4a587a">Log in or sign up with ${escapeHtml(to)} to accept. The invitation expires in ${n.expiresInDays} days.</p>
      </div>`,
  })
}
