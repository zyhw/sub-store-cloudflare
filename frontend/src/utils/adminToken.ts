export const ADMIN_TOKEN_STORAGE_KEY = 'substore_admin_token';

export const syncAdminTokenFromUrl = () => {
  if (typeof window === 'undefined') return;

  const token = new URLSearchParams(window.location.search).get('token');
  if (token) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
};

export const getStoredAdminToken = () => {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '';
};
