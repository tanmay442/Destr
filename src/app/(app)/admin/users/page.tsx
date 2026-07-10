import { getComposition, unwrap, parsePageParam } from '@/composition';
import { UserRowActions } from './user-row-actions';
import { Pagination } from '@/components/admin/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">Users</h2>
      <form className="flex gap-2" method="get" aria-label="Search users">
        <Label className="sr-only" htmlFor="users-search">
          Search users
        </Label>
        <Input
          id="users-search"
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Search name or email…"
          className="flex-1 bg-background"
          data-testid="users-search"
        />
        <Button type="submit">Search</Button>
      </form>
      <div className="overflow-x-auto rounded-xl border border">
        <Table data-testid="users-table" aria-label="Users">
          <TableHeader className="bg-secondary text-muted-foreground">
            <TableRow>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Name
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Email
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Role
              </TableHead>
              <TableHead className="px-3 py-2 text-right text-xs uppercase">
                Last seen
              </TableHead>
              <TableHead className="px-3 py-2 text-right text-xs uppercase">
                Created
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.users.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No users.
                </TableCell>
              </TableRow>
            ) : (
              result.users.map((u) => (
                <TableRow
                  key={u.clerkUserId}
                  className="border-border-subtle hover:bg-secondary/40"
                  data-testid={`users-row-${u.clerkUserId}`}
                >
                  <TableCell className="px-3 py-2 font-medium text-foreground">
                    {u.name ?? '—'}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs">
                    {u.role === 'admin' ? (
                      <Badge className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">
                        admin
                      </Badge>
                    ) : (
                      <Badge className="rounded-full border border bg-card px-2 py-0.5 text-muted-foreground">
                        user
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground">
                    {u.lastSeenAt
                      ? u.lastSeenAt.toISOString()
                      : '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground">
                    {u.createdAt.toISOString()}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <UserRowActions
                      clerkUserId={u.clerkUserId}
                      role={u.role as 'admin' | 'user'}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
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
