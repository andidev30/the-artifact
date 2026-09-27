import { env } from '../env.js'
import { escapeHtml, transport } from '../mail.js'

export type SalesInquiry = { name: string; email: string; company: string; teamSize: string; topic: string; message: string }

// The contact-sales form. Goes to SALES_EMAIL (the sender address when unset); replying answers the person who wrote.
export async function sendSalesInquiry(q: SalesInquiry) {
  const to = process.env.SALES_EMAIL?.trim() || env.smtp.from
  const rows: [string, string][] = [
    ['Name', q.name],
    ['Email', q.email],
    ['Company', q.company],
    ['Team size', q.teamSize],
    ['Interested in', q.topic],
  ]
  await transport.sendMail({
    from: env.smtp.from,
    to,
    replyTo: { name: q.name, address: q.email },
    subject: `Sales inquiry from ${q.name} at ${q.company}`,
    text: `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${q.message}\n\nReply to this email to answer ${q.name}.`,
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #1c2b4b; max-width: 560px">
        <p style="font-size: 16px">New message from the contact sales form.</p>
        <table style="font-size: 14px; border-collapse: collapse">
          ${rows.map(([k, v]) => `<tr><td style="padding: 2px 16px 2px 0; color: #4a587a">${k}</td><td style="padding: 2px 0">${escapeHtml(v)}</td></tr>`).join('')}
        </table>
        <p style="padding: 10px 14px; background: #f5f7fb; border-left: 3px solid #1c2b4b; white-space: pre-wrap">${escapeHtml(q.message)}</p>
        <p style="font-size: 14px; color: #4a587a">Reply to this email to answer ${escapeHtml(q.name)}.</p>
      </div>`,
  })
}
