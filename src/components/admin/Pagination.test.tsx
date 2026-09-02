import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  it('uses cursor links and preserves filters without carrying offset state', () => {
    render(
      <Pagination
        page={2}
        totalPages={4}
        total={80}
        nextCursor="next-token"
        previousCursor="previous-token"
        pathname="/admin/users"
        query={{ search: 'Ada', page: 2, offset: 25, cursor: 'old-token' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute(
      'href',
      '/admin/users?search=Ada&page=1&before=previous-token',
    );
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/admin/users?search=Ada&page=3&cursor=next-token',
    );
  });
});
