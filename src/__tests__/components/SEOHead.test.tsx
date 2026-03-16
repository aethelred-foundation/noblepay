import React from 'react';
import { render } from '@testing-library/react';
import { SEOHead } from '@/components/SEOHead';

// next/head is already mocked in jest.setup.js to render children as fragments

describe('SEOHead', () => {
  it('renders without errors', () => {
    const { container } = render(
      <SEOHead title="Dashboard" description="NoblePay Dashboard" />,
    );
    expect(container).toBeTruthy();
  });

  it('renders full title with NoblePay suffix', () => {
    const { container } = render(
      <SEOHead title="Payments" description="Manage payments" />,
    );

    const titleEl = container.querySelector('title');
    expect(titleEl?.textContent).toBe('Payments | NoblePay');
  });

  it('renders meta description', () => {
    const { container } = render(
      <SEOHead title="Compliance" description="Compliance center overview" />,
    );

    const descMeta = container.querySelector('meta[name="description"]');
    expect(descMeta).toHaveAttribute('content', 'Compliance center overview');
  });

  it('renders canonical URL with path', () => {
    const { container } = render(
      <SEOHead title="Payments" description="Desc" path="/payments" />,
    );

    const canonical = container.querySelector('link[rel="canonical"]');
    expect(canonical).toHaveAttribute(
      'href',
      'https://noblepay.aethelred.network/payments',
    );
  });

  it('renders canonical URL without path (defaults to root)', () => {
    const { container } = render(
      <SEOHead title="Dashboard" description="Desc" />,
    );

    const canonical = container.querySelector('link[rel="canonical"]');
    expect(canonical).toHaveAttribute(
      'href',
      'https://noblepay.aethelred.network',
    );
  });

  it('renders OpenGraph title', () => {
    const { container } = render(
      <SEOHead title="Analytics" description="Analytics page" />,
    );

    const ogTitle = container.querySelector('meta[property="og:title"]');
    expect(ogTitle).toHaveAttribute('content', 'Analytics | NoblePay');
  });

  it('renders OpenGraph description', () => {
    const { container } = render(
      <SEOHead title="Analytics" description="Analytics page" />,
    );

    const ogDesc = container.querySelector('meta[property="og:description"]');
    expect(ogDesc).toHaveAttribute('content', 'Analytics page');
  });

  it('renders OpenGraph type as website', () => {
    const { container } = render(
      <SEOHead title="Test" description="Test" />,
    );

    const ogType = container.querySelector('meta[property="og:type"]');
    expect(ogType).toHaveAttribute('content', 'website');
  });

  it('renders OpenGraph site name', () => {
    const { container } = render(
      <SEOHead title="Test" description="Test" />,
    );

    const ogSiteName = container.querySelector('meta[property="og:site_name"]');
    expect(ogSiteName).toHaveAttribute('content', 'NoblePay');
  });

  it('renders OpenGraph image', () => {
    const { container } = render(
      <SEOHead title="Test" description="Test" />,
    );

    const ogImage = container.querySelector('meta[property="og:image"]');
    expect(ogImage).toHaveAttribute(
      'content',
      'https://noblepay.aethelred.network/og-image.svg',
    );
  });

  it('renders OpenGraph URL with path', () => {
    const { container } = render(
      <SEOHead title="Test" description="Test" path="/compliance" />,
    );

    const ogUrl = container.querySelector('meta[property="og:url"]');
    expect(ogUrl).toHaveAttribute(
      'content',
      'https://noblepay.aethelred.network/compliance',
    );
  });

  it('renders Twitter card meta tags', () => {
    const { container } = render(
      <SEOHead title="Test" description="Test description" />,
    );

    const twitterCard = container.querySelector('meta[name="twitter:card"]');
    expect(twitterCard).toHaveAttribute('content', 'summary_large_image');

    const twitterTitle = container.querySelector('meta[name="twitter:title"]');
    expect(twitterTitle).toHaveAttribute('content', 'Test | NoblePay');

    const twitterDesc = container.querySelector('meta[name="twitter:description"]');
    expect(twitterDesc).toHaveAttribute('content', 'Test description');

    const twitterImage = container.querySelector('meta[name="twitter:image"]');
    expect(twitterImage).toHaveAttribute(
      'content',
      'https://noblepay.aethelred.network/og-image.svg',
    );
  });
});
