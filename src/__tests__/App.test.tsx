/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from '../renderer/src/App';

describe('App', () => {
  it('should render', () => {
    expect(render(<App />)).toBeTruthy();
  });
});
