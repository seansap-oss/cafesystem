/* Minimal SMTP client (no deps) + honest delivery status.
 * Never reports success unless the SMTP server accepts the message.
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function smtpSend(cfg, { to, subject, text, attachments }) {
  return new Promise((resolve) => {
    if (!cfg || !cfg.host || !cfg.from || !to || !to.length) {
      return resolve({ ok: false, status: 'not_configured', detail: 'Email is not configured. Set SMTP host, port, user and from-address in Admin → Finance settings.' });
    }
    const port = Number(cfg.port) || 587;
    const useTls = port === 465;
    let socket = null;
    let step = 0;
    let buffer = '';
    const timeout = setTimeout(() => { try { socket.destroy(); } catch (e) {} resolve({ ok: false, status: 'failed', detail: 'SMTP timeout' }); }, 20000);

    const boundary = 'karims_' + crypto.randomBytes(8).toString('hex');
    let data = '';
    data += `From: ${cfg.from}\r\n`;
    data += `To: ${to.join(', ')}\r\n`;
    data += `Subject: ${subject}\r\n`;
    data += `MIME-Version: 1.0\r\n`;
    if (attachments && attachments.length) {
      data += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
      data += `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
      for (const att of attachments) {
        data += `--${boundary}\r\nContent-Type: ${att.contentType || 'application/octet-stream'}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${att.filename}"\r\n\r\n`;
        data += b64(att.content.toString('base64')).replace(/(.{76})/g, '$1\r\n') + '\r\n';
      }
      data += `--${boundary}--\r\n`;
    } else {
      data += `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
    }
    data += '.\r\n';

    const script = [
      { expect: /220/, send: () => `EHLO karims.local\r\n` },
      { expect: /250/, send: () => {
        if (cfg.user && cfg.pass) return `AUTH LOGIN\r\n`;
        return useTls || port === 587 ? `STARTTLS\r\n` : `MAIL FROM:<${cfg.from}>\r\n`;
      } },
      { expect: /334/, send: () => b64(cfg.user) + '\r\n' },
      { expect: /334/, send: () => b64(cfg.pass) + '\r\n' },
      { expect: /235/, send: () => useTls || port === 587 ? `STARTTLS\r\n` : `MAIL FROM:<${cfg.from}>\r\n` },
      { expect: /220/, send: () => `EHLO karims.local\r\n`, upgradeTls: true },
      { expect: /250/, send: () => `MAIL FROM:<${cfg.from}>\r\n` },
      { expect: /250/, send: () => to.map(a => `RCPT TO:<${a}>`).join('\r\n') + '\r\n' },
      { expect: /250/, send: () => `DATA\r\n` },
      { expect: /354/, send: () => data },
      { expect: /250/, send: () => `QUIT\r\n`, done: true }
    ];

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length < 4) return;
      // wait for complete reply line(s)
      if (!/\r\n$/.test(buffer) && !/\n$/.test(buffer)) return;
      const reply = buffer; buffer = '';
      const s = script[step];
      if (!s) return;
      if (!s.expect.test(reply)) {
        clearTimeout(timeout);
        try { socket.destroy(); } catch (e) {}
        return resolve({ ok: false, status: 'failed', detail: 'SMTP rejected at step ' + (step + 1) + ': ' + reply.split('\r\n')[0] });
      }
      if (s.done) {
        clearTimeout(timeout);
        return resolve({ ok: true, status: 'sent', detail: 'SMTP server accepted the message (step ' + (step + 1) + ').' });
      }
      step++;
      socket.write(script[step].send());
    };

    const connectPlain = () => {
      socket = net.connect(port, cfg.host, () => {});
      socket.on('data', onData);
      socket.on('error', (e) => { clearTimeout(timeout); resolve({ ok: false, status: 'failed', detail: 'SMTP connection error: ' + e.message }); });
    };

    if (useTls) {
      socket = tls.connect(port, cfg.host, { rejectUnauthorized: false }, () => {});
      socket.on('data', onData);
      socket.on('error', (e) => { clearTimeout(timeout); resolve({ ok: false, status: 'failed', detail: 'SMTP TLS error: ' + e.message }); });
    } else {
      connectPlain();
    }
  });
}

/* WhatsApp share — Option A (manual deep link). Option B requires Business API credentials. */
function whatsappShare(cfg, { number, text }) {
  if (cfg && cfg.provider && cfg.apiToken) {
    return { mode: 'api_configured', ok: false, status: 'not_implemented',
      detail: 'WhatsApp Business API credentials are present but automated sending is not enabled in this build. Download the PDF/Markdown and share manually, or configure a provider integration.' };
  }
  const phone = String(number || (cfg && cfg.defaultNumber) || '').replace(/[^\d]/g, '');
  const url = 'https://wa.me/' + (phone.length >= 10 ? phone.slice(-10) : '') + '?text=' + encodeURIComponent(text || '');
  return { mode: 'manual_link', ok: true, status: 'ready', url,
    detail: 'Manual share: opens WhatsApp with a pre-filled summary. Attach the downloaded PDF manually — WhatsApp cannot attach files from a browser link.' };
}

module.exports = { smtpSend, whatsappShare };
