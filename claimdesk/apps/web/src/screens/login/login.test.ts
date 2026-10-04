import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { DEFAULT_LOGIN_USERNAME, LOGIN_MESSAGES, loginErrorMessage, loginFormError, loginPrefill } from './login';

describe('loginPrefill (GET /auth/login-defaults → the two boxes)', () => {
  it('fills both boxes with the default account while the API sends the password', () => {
    expect(loginPrefill({ username: 'courtesycars', password: 'CourtesyCars123!', prefill: true })).toEqual({ username: 'courtesycars', password: 'CourtesyCars123!' });
  });
  it('fills only the username once the default password has been changed (no password in the reply)', () => {
    expect(loginPrefill({ username: 'courtesycars', prefill: true })).toEqual({ username: 'courtesycars', password: '' });
  });
  it('falls back to the default username when the call failed or has not answered', () => {
    expect(DEFAULT_LOGIN_USERNAME).toBe('courtesycars');
    expect(loginPrefill(undefined)).toEqual({ username: 'courtesycars', password: '' });
    expect(loginPrefill(null)).toEqual({ username: 'courtesycars', password: '' });
  });
  it('leaves both boxes empty when LOGIN_PREFILL is off', () => {
    expect(loginPrefill({ username: 'courtesycars', password: 'CourtesyCars123!', prefill: false })).toEqual({ username: '', password: '' });
  });
  it('uses a configured username and trims it; a blank one becomes the default', () => {
    expect(loginPrefill({ username: '  ops ', prefill: true })).toEqual({ username: 'ops', password: '' });
    expect(loginPrefill({ username: '', prefill: true })).toEqual({ username: 'courtesycars', password: '' });
  });
});

describe('loginFormError', () => {
  it('asks for whatever is missing', () => {
    expect(loginFormError({ username: '', password: '' })).toBe('Enter your username and password.');
    expect(loginFormError({ username: '  ', password: 'x' })).toBe('Enter your username.');
    expect(loginFormError({ username: 'courtesycars', password: '' })).toBe('Enter your password.');
    expect(loginFormError({ username: 'courtesycars', password: 'CourtesyCars123!' })).toBeNull();
  });
});

describe('loginErrorMessage (POST /auth/login failures → one clear line)', () => {
  it('wrong username or password', () => {
    expect(loginErrorMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect', '/api/auth/login'))).toBe(LOGIN_MESSAGES.invalid);
    expect(LOGIN_MESSAGES.invalid).toBe('Username or password is incorrect.');
    expect(loginErrorMessage(new ApiError(401, 'HTTP_401', 'Unauthorized', '/api/auth/login'))).toBe(LOGIN_MESSAGES.invalid);
  });
  it('rate limited after repeated failures', () => {
    expect(loginErrorMessage(new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many attempts', '/api/auth/login'))).toBe(LOGIN_MESSAGES.rateLimited);
    expect(loginErrorMessage(new ApiError(429, 'HTTP_429', 'Too Many Requests', '/api/auth/login'))).toBe(LOGIN_MESSAGES.rateLimited);
    expect(LOGIN_MESSAGES.rateLimited).toMatch(/15 minutes/);
  });
  it('API down or failing', () => {
    expect(loginErrorMessage(new ApiError(0, 'NETWORK', 'fetch failed', '/api/auth/login'))).toBe(LOGIN_MESSAGES.network);
    expect(loginErrorMessage(new ApiError(502, 'HTTP_502', 'Bad Gateway', '/api/auth/login'))).toBe(LOGIN_MESSAGES.network);
    expect(loginErrorMessage(new ApiError(500, 'INTERNAL', 'boom', '/api/auth/login'))).toBe(LOGIN_MESSAGES.server);
  });
  it('validation and anything else', () => {
    expect(loginErrorMessage(new ApiError(400, 'VALIDATION', 'body/password must be string', '/api/auth/login'))).toBe('Enter your username and password.');
    expect(loginErrorMessage(new ApiError(403, 'FORBIDDEN', 'Account disabled', '/api/auth/login'))).toBe('Account disabled');
    expect(loginErrorMessage(new Error('weird'))).toBe('weird');
    expect(loginErrorMessage(null)).toBe('');
  });
  it('never echoes a password back', () => {
    const msg = loginErrorMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect', '/api/auth/login'));
    expect(msg).not.toMatch(/CourtesyCars123!/);
  });
});
