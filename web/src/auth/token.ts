// Auth token management for JWT-based authentication

const TOKEN_KEY = 'auth_token';

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
}

export function getAuthHeaders(): HeadersInit {
    const token = getToken();
    if (!token) return {};
    return {
        'Authorization': `Bearer ${token}`,
    };
}

// Check URL for token param (after OAuth redirect)
export function captureTokenFromURL(): boolean {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    
    if (token) {
        setToken(token);
        // Remove token from URL
        params.delete('token');
        const newURL = params.toString() 
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newURL);
        return true;
    }
    
    return false;
}
