const nodemailer = require('nodemailer');

(async () => {
  const host = process.env.SMTP_HOST || 'smtp.office365.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  const user = process.env.SMTP_USER || 'noreply@republicfinancialservices.com';
  const pass = process.env.SMTP_PASS || 'Republic2025$'; 
  const from = process.env.EMAIL_FROM || user;
  const to = process.env.TEST_TO || user; // change TEST_TO if you want

  console.log(`[smtp-test] connecting host=${host} port=${port} secure=${secure} user=${user}`);

  const transporter = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: true }, // STARTTLS
  });

  try {
    await transporter.verify();
    console.log('[smtp-test] verify: OK (can login & starttls)');
  } catch (e) {
    console.error('[smtp-test] verify FAILED:', e && (e.response || e.message || e));
    process.exit(1);
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'SMTP Test (Attendance server)',
      text: 'This is a test email from the EC2 server.'
    });
    console.log('[smtp-test] send OK:', info.messageId || info);
  } catch (e) {
    console.error('[smtp-test] send FAILED:', e && (e.response || e.message || e));
    process.exit(2);
  }
})();
