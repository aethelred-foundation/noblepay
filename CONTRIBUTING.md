# Contributing to NoblePay

Thank you for your interest in contributing to NoblePay! This guide will help you get started.

## Code of Conduct

By participating, you agree to uphold a welcoming, respectful, and harassment-free environment for everyone.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install** dependencies: `npm ci`
4. **Create** a feature branch: `git checkout -b feature/my-feature`

## Before Submitting

Run the full validation suite:

```bash
npm run validate    # lint + type-check + format + tests
```

## Pull Request Guidelines

1. **Branch naming**: `feature/`, `fix/`, `docs/`, `refactor/`, `test/`
2. **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/)
3. **Tests**: Add or update tests for your changes
4. **One concern per PR**: Keep PRs focused and reviewable

## Security Issues

**Do NOT** file security issues as public GitHub issues. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
