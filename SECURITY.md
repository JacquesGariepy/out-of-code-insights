# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Out-of-Code Insights, please report
it **privately** by email:

**jacques.gariepy@outlook.com**

You may also use GitHub's native private vulnerability reporting:
https://github.com/JacquesGariepy/out-of-code-insights/security/advisories/new

Do not open a public GitHub issue for security vulnerabilities. Public
disclosure before a fix is available puts all users at risk.

Include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- VS Code version, extension version, and operating system
- Any relevant logs or screenshots (redact API keys and file paths)

## Threat Model

This extension runs in the VS Code extension-host process with broad access to
the development environment: it can read and write files anywhere on the
filesystem, access environment variables (which frequently contain API keys,
tokens, and credentials), interact with integrated terminals, and read from the
VS Code SecretStorage API. A vulnerability in this extension can therefore
compromise the complete developer workstation, including source code
repositories, CI/CD credentials, and cloud access tokens. Maintainers treat
security reports with high priority for this reason. All security fixes will be
published as source code changes under MPL-2.0.

## Supported Versions

| Version                                | Supported                                       |
| -------------------------------------- | ----------------------------------------------- |
| Latest minor version (currently 1.0.x) | Yes                                             |
| Older versions                         | No -- upgrade to the latest Marketplace release |

## Disclosure Process

1. Send a private report to **jacques.gariepy@outlook.com** with full details.
2. You will receive an acknowledgment within **7 days**.
3. A fix will be developed and tested. You will be kept informed of progress.
4. Fix timeline targets: **critical** within 14 days, **high** within 30 days,
   **medium** within 90 days (from acknowledgment).
5. Once the fix is released, a GitHub Security Advisory will be published
   crediting the reporter (unless anonymity is requested).

## Out of Scope

- Vulnerabilities in VS Code itself -- report to Microsoft at <https://aka.ms/vscode-security>
- Local denial-of-service attacks with no network impact
- Attacks requiring physical access to the developer's machine
- Issues requiring active, intentional cooperation of the user (e.g., the
  user voluntarily opening a malicious workspace they chose to install)
- Vulnerabilities in third-party LLM provider APIs -- report to the
  respective provider
