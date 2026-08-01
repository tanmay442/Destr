import { getComposition, unwrap, parsePageParam } from '@/composition';
import { UserRowActions } from './user-row-actions';
import { Pagination } from '@/components/admin/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function formatRelative(d: Date | null): string {
  if (!d) return '—';
  const diff = Math.max(0, Date.now() - d.getTime());
  const day = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (day < 1) return 'today';
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const search = params.search?.trim() ?? '';
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const result = unwrap(await getComposition().listUsers({
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  }));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Users</h2>
        <p className="text-sm text-muted-foreground">
          Promote or demote workspace members. Search by name or email.
        </p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        method="get"
        aria-label="Search users"
      >
        <Label className="sr-only" htmlFor="users-search">
          Search users
        </Label>
        <Input
          id="users-search"
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Search name or email…"
          className="flex-1"
          data-testid="users-search"
        />
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>
      {result.users.length === 0 ? (
        <Card className="border-dashed p-8 shadow-none">
          <div className="flex flex-col items-center gap-1 text-center">
            <CardTitle className="text-base">No users</CardTitle>
            <CardDescription>No users matched your filters.</CardDescription>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-strong bg-card/50">
          <Table data-testid="users-table" aria-label="Users">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="w-24">Role</TableHead>
                <TableHead className="hidden w-32 text-right lg:table-cell">Last seen</TableHead>
                <TableHead className="hidden w-32 text-right lg:table-cell">Created</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.users.map((u) => (
                <TableRow
                  key={u.clerkUserId}
                  data-testid={`users-row-${u.clerkUserId}`}
                >
                  <TableCell className="max-w-[200px] font-medium text-foreground">
                    <div className="flex flex-col">
                      <span className="truncate" title={u.name ?? ''}>
                        {u.name ?? '—'}
                      </span>
                      <span className="truncate text-xs text-muted-foreground md:hidden">
                        {u.email}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    {u.role === 'admin' ? (
                      <Badge variant="outline" className="border-primary/40 text-primary">
                        admin
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        user
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums lg:table-cell">
                    {formatRelative(u.lastSeenAt)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums lg:table-cell">
                    <time dateTime={u.createdAt.toISOString()} title={u.createdAt.toISOString()}>
                      {u.createdAt.toISOString().slice(0, 10)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right">
                    <UserRowActions
                      clerkUserId={u.clerkUserId}
                      role={u.role as 'admin' | 'user'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/users"
        query={{ search }}
      />
    </section>
  );
}
