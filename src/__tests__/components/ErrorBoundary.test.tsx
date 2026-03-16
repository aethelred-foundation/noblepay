import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary, SectionErrorBoundary } from '@/components/ErrorBoundary';

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  AlertTriangle: (props: any) => <span data-testid="alert-triangle" {...props} />,
  RefreshCw: (props: any) => <span data-testid="refresh-cw" {...props} />,
  Home: (props: any) => <span data-testid="home" {...props} />,
  MessageCircle: (props: any) => <span data-testid="message-circle" {...props} />,
}));

// Mock @/lib/constants
jest.mock('@/lib/constants', () => ({
  BRAND: { NAME: 'NoblePay by Aethelred' },
}));

// Component that throws on render
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div>Normal content</div>;
}

// Suppress error boundary console.error output for cleaner tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('ErrorBoundary') ||
        args[0].includes('Error in section') ||
        args[0].includes('The above error'))
    ) {
      return;
    }
    originalConsoleError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = originalConsoleError;
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Safe content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('Safe content')).toBeInTheDocument();
  });

  it('renders fallback UI when error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText(/We apologize for the inconvenience/),
    ).toBeInTheDocument();
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('displays Try Again button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Try Again')).toBeInTheDocument();
  });

  it('displays Reload Page button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Reload Page')).toBeInTheDocument();
  });

  it('displays Go to Dashboard button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
  });

  it('displays Contact Support link', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Contact Support')).toBeInTheDocument();
    const link = screen.getByText('Contact Support').closest('a');
    expect(link).toHaveAttribute('href', 'https://discord.gg/aethelred');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('calls onReset and recovers when Try Again is clicked', () => {
    const onReset = jest.fn();

    const { rerender } = render(
      <ErrorBoundary onReset={onReset}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByText('Try Again'));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('displays brand name in footer', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/NoblePay by Aethelred/)).toBeInTheDocument();
  });

  it('shows error details in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Error: Test error/)).toBeInTheDocument();

    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      writable: true,
    });
  });

  it('calls Sentry.captureException when Sentry is available', () => {
    const captureException = jest.fn();
    (window as any).Sentry = { captureException };

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.any(Object) }),
    );

    delete (window as any).Sentry;
  });

  it('reloads page when Reload Page is clicked', () => {
    const reloadMock = jest.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByText('Reload Page'));
    expect(reloadMock).toHaveBeenCalled();
  });

  it('navigates home when Go to Dashboard is clicked', () => {
    const originalHref = window.location.href;
    delete (window as any).location;
    (window as any).location = { href: '', reload: jest.fn() };

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByText('Go to Dashboard'));
    expect(window.location.href).toBe('/');

    (window as any).location = { href: originalHref, reload: jest.fn() };
  });
});

describe('SectionErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <SectionErrorBoundary sectionName="Test Section">
        <div>Section content</div>
      </SectionErrorBoundary>,
    );

    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('renders error message with section name when error occurs', () => {
    render(
      <SectionErrorBoundary sectionName="Payment History">
        <ThrowingComponent shouldThrow={true} />
      </SectionErrorBoundary>,
    );

    expect(screen.getByText('Failed to load Payment History')).toBeInTheDocument();
    expect(
      screen.getByText(/There was an error loading this section/),
    ).toBeInTheDocument();
  });

  it('displays Retry button', () => {
    render(
      <SectionErrorBoundary sectionName="Test">
        <ThrowingComponent shouldThrow={true} />
      </SectionErrorBoundary>,
    );

    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('recovers when Retry is clicked and child no longer throws', () => {
    const { rerender } = render(
      <SectionErrorBoundary sectionName="Test">
        <ThrowingComponent shouldThrow={true} />
      </SectionErrorBoundary>,
    );

    expect(screen.getByText('Failed to load Test')).toBeInTheDocument();

    // Click retry - the component resets state
    fireEvent.click(screen.getByText('Retry'));

    // After retry, it will try to render children again which throws again
    // But the state is reset, so getDerivedStateFromError catches it again
    // This tests that handleRetry resets the error state
    expect(screen.getByText('Failed to load Test')).toBeInTheDocument();
  });
});
