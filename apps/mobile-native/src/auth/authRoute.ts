export type ConfigurationState = 'loading' | 'missing' | 'ready';
export type AuthenticationState = 'unknown' | 'checking' | 'signed-out' | 'signed-in';
export type AuthRoute = 'loading' | 'server-setup' | 'login' | 'main';

export interface AuthRouteState {
  configuration: ConfigurationState;
  authentication: AuthenticationState;
}

export function resolveAuthRoute(state: AuthRouteState): AuthRoute {
  if (state.configuration === 'loading') return 'loading';
  if (state.configuration === 'missing') return 'server-setup';
  if (state.authentication === 'signed-in') return 'main';
  if (state.authentication === 'signed-out') return 'login';
  return 'loading';
}
