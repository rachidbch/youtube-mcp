# Security policy

## Supported versions

Security fixes target the latest published release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, impact, reproduction steps, and any proposed mitigation.

Never include an `API_TOKEN` value, cookie, or authorization header in a report. Replace any token that may have been exposed.

## Credential model

The stdio server needs no credentials: it reads only public YouTube data without an API key or account. In HTTP mode, the optional `API_TOKEN` is read from the process environment and is not persisted. Set it whenever the HTTP endpoint is reachable by anyone other than you, and serve it behind TLS.
