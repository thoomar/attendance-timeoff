// /opt/attendance-timeoff/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'attendance-api',
      cwd: '/opt/attendance-timeoff',
      script: 'server/dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,

        // --- DB ---
        DATABASE_URL: 'postgres://app:app@127.0.0.1:5433/attendance',

        // --- SMTP (Office365) ---
        SMTP_HOST: 'smtp.office365.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false', // STARTTLS
        SMTP_USER: 'noreply@republicfinancialservices.com',
        SMTP_PASS: 'Republic2025$',
        EMAIL_FROM: 'noreply@republicfinancialservices.com',
        FROM_EMAIL: 'noreply@republicfinancialservices.com',

        // --- Notifications ---
        HR_EMAILS: 'hr@republicfinancialservices.com',
        APPROVER_EMAILS: 'sam@republicfinancialservices.com,zaid@republicfinancialservices.com,freddie@republicfinancialservices.com,donald@republicfinancialservices.com',
        MANAGER_NOTIFY_LIST: 'sam@republicfinancialservices.com,zaid@republicfinancialservices.com,freddie@republicfinancialservices.com,donald@republicfinancialservices.com',

        // --- Zoho OAuth ---
        ZOHO_CLIENT_ID: '1000.FHO2JF1RU48MOSMHIPXWEPELS7J3XT',
        ZOHO_CLIENT_SECRET: 'c3c370529bfa666d86c3562172789e3944d13437b5',
        ZOHO_SCOPES: 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL ZohoCRM.users.READ AaaServer.profile.Read',
        ZOHO_ACCOUNTS_BASE: 'https://accounts.zoho.com',
        // IMPORTANT: trailing slash here to match what’s registered in Zoho API console
        ZOHO_REDIRECT_URI: 'https://timeoff.timesharehelpcenter.com/api/zoho/callback/',
        FRONTEND_REDIRECT_SUCCESS: 'https://timeoff.timesharehelpcenter.com',
        FRONTEND_REDIRECT_ERROR:   'https://timeoff.timesharehelpcenter.com/time-off?zohoError=1',
        // --- Cron ---
        CRON_SECRET: 'change_this_to_a_random_long_secret'
      }
    }
  ]
};
