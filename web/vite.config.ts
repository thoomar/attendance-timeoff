import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Impersonate a user for dev (the server supports x-dev-user)
const devUser = {
    id: 'dev-1',
    email: 'dev.admin@timesharehelpcenter.com',
    fullName: 'Dev Admin',
    role: 'Admin',          // change to 'Enrollment Specialist' to test requester flow
    managerUserId: null
}

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/api': {
                target: 'https://timeoff.timesharehelpcenter.com',
                changeOrigin: true,
                secure: true,
                // inject our dev user header so the live API authorizes dev requests
                configure: (proxy) => {
                    proxy.on('proxyReq', (proxyReq) => {
                        if (!proxyReq.getHeader('x-dev-user')) {
                            proxyReq.setHeader('x-dev-user', JSON.stringify(devUser))
                        }
                    })
                },
            },
        },
    },
})
