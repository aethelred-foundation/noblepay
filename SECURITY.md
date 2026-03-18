# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Reporting a Vulnerability

The Aethelred Foundation takes security seriously. If you discover a security vulnerability in NoblePay, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities.
2. Email **security@aethelred.io** with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Any suggested fixes (optional)

### What to Expect

- **Acknowledgment** within 48 hours of your report.
- **Assessment** within 5 business days with an initial severity classification.
- **Resolution timeline** communicated based on severity:
  - **Critical**: Fix within 24-48 hours
  - **High**: Fix within 7 days
  - **Medium**: Fix within 30 days
  - **Low**: Fix in next scheduled release

### Scope

This policy applies to:
- The NoblePay frontend application
- The backend API and payment gateway
- Smart contracts
- Compliance and security services
- CI/CD infrastructure

## Security Measures

- All dependencies are monitored via Dependabot and `npm audit`
- Smart contracts undergo formal security audits
- TEE-based compliance verification for cross-border transactions
- See [security_best_practices_report.md](security_best_practices_report.md) for detailed security practices
