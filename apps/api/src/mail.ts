import nodemailer from 'nodemailer'
import { env } from './env.js'

const transport = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.secure,
  auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
})

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
