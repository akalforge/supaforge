# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously — especially given SupaForge is a security-relevant tool (see CVE-2025-48757).

### Please do NOT

- Open a public GitHub issue for security vulnerabilities
- Discuss the vulnerability in public forums or social media

### Please DO

1. **Email us** at **security@jasdeepkhalsa.com** with:
   - A description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact
   - Suggested fixes (if available)

2. **Wait for our response** — we aim to acknowledge within 48 hours

3. **Allow reasonable time** for us to fix the issue before any public disclosure

## What to Expect

- **Acknowledgement** within 48 hours of your report
- **Assessment** of severity and impact
- **Fix and release** as a priority patch
- **Public disclosure** once the fix is released (with credit to you, if desired)

## Security Best Practices for Users

- **Never commit credentials** — use environment variables or a `.env` file (listed in `.gitignore`)
- **Use service-role keys carefully** — they bypass RLS; restrict access to trusted CI/CD
- **Keep dependencies updated** — run `npm audit` regularly
- **Review scan results** — act on critical RLS and auth drift immediately
