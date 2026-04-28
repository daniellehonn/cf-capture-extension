# Authentication & Authorization Design

## Overview

The application uses **Better Auth** for authentication with a custom user model (`pirates` table) and role-based access control (RBAC) for authorization.

## Technology Stack

- **Provider**: Better Auth (https://better-auth.com)
- **Session Type**: JWT-based
- **Session Duration**: 7 days
- **Auth Methods**: Email/password, Google OAuth
- **User Storage**: Custom `pirates` table in PostgreSQL

## User Model

### Pirates Table

```sql
CREATE TABLE pirates (
  pirate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR UNIQUE,
  email VARCHAR UNIQUE NOT NULL,
  password_hash TEXT,
  image_url TEXT,
  roles TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

### Role-Based Access Control

Roles are stored as a text array in the `roles` column:

```sql
-- Single role
UPDATE pirates SET roles = ARRAY['admin'] WHERE pirate_id = '...';

-- Multiple roles
UPDATE pirates SET roles = ARRAY['admin', 'moderator'] WHERE pirate_id = '...';

-- Check for role
SELECT * FROM pirates WHERE 'admin' = ANY(roles);
```

### Admin Check

A user is considered an admin if:
1. Their `roles` array includes `'admin'`, OR
2. Their `username` is exactly `'admin'`

```typescript
const isAdmin = user?.roles?.includes('admin') || user?.username === 'admin';
```

## Configuration

### Better Auth Setup

**Location:** `apps/web/lib/auth.config.ts`

```typescript
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

export const { auth, signIn, signUp, signOut } = betterAuth({
  database: prismaAdapter(prisma),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  plugins: [nextCookies()],
});
```

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host/db

# Better Auth
BETTER_AUTH_SECRET=your-secret-key
BETTER_AUTH_URL=http://localhost:3000

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

## Authentication Flow

### Sign Up

```
POST /api/auth/signup
{
  "email": "user@example.com",
  "password": "password123",
  "username": "username"
}
    ↓
Better Auth validates input
    ↓
Hash password (bcrypt)
    ↓
Insert into pirates table
    ↓
Create JWT session
    ↓
Set session cookie
    ↓
Return user data
```

### Sign In

```
POST /api/auth/signin
{
  "email": "user@example.com",
  "password": "password123"
}
    ↓
Better Auth finds user by email
    ↓
Verify password hash
    ↓
Create JWT session
    ↓
Set session cookie
    ↓
Return user data
```

### Google OAuth

```
GET /api/auth/signin/google
    ↓
Redirect to Google consent screen
    ↓
User approves
    ↓
Google redirects to callback
    ↓
Better Auth exchanges code for tokens
    ↓
Get user info from Google
    ↓
Create/update pirates record
    ↓
Create JWT session
    ↓
Set session cookie
    ↓
Redirect to app
```

## Session Management

### Getting Session in API Routes

```typescript
import { getAuth } from '@/lib/auth.config';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET(request: NextRequest) {
  const { env } = getCloudflareContext();
  const { auth, ready } = getAuth(env);
  await ready;

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Access user data
  const userId = session.user.id;
  const userEmail = session.user.email;
  const userName = session.user.name;

  // ...
}
```

### Getting Session in Server Components

```typescript
import { getAuth } from '@/lib/auth.config';
import { headers } from 'next/headers';

export default async function Page() {
  const { env } = getCloudflareContext();
  const { auth, ready } = getAuth(env);
  await ready;

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect('/login');
  }

  return <div>Welcome, {session.user.name}</div>;
}
```

### Client-Side Session

```typescript
import { createAuthClient } from 'better-auth/react';

const { useSession } = createAuthClient();

function ProfilePage() {
  const { data: session, isPending } = useSession();

  if (isPending) return <div>Loading...</div>;
  if (!session) return <div>Not logged in</div>;

  return <div>Welcome, {session.user.name}</div>;
}
```

## Authorization Patterns

### API Route Protection

```typescript
export async function GET(request: NextRequest) {
  const { env } = getCloudflareContext();
  const { auth, ready } = getAuth(env);
  await ready;

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Fetch user with roles from database
  const userResult = await query(
    `SELECT pirate_id, username, email, roles FROM pirates WHERE pirate_id = $1`,
    [session.user.id],
    env
  );

  const user = userResult.rows[0];

  // Check admin role
  if (!user?.roles?.includes('admin') && user?.username !== 'admin') {
    return NextResponse.json(
      { error: 'Forbidden - Admin only' },
      { status: 403 }
    );
  }

  // Proceed with admin-only logic
}
```

### Server Component Protection

```typescript
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';

export default async function AdminPage() {
  const { env } = getCloudflareContext();
  const { auth, ready } = getAuth(env);
  await ready;

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect('/login');
  }

  // Check admin role
  const userResult = await query(
    `SELECT username, roles FROM pirates WHERE pirate_id = $1`,
    [session.user.id],
    env
  );

  const user = userResult.rows[0];
  const isAdmin = user?.roles?.includes('admin') || user?.username === 'admin';

  if (!isAdmin) {
    redirect('/workspace');
  }

  return <AdminDashboard />;
}
```

### Reusable Auth Helper

```typescript
// lib/auth-helpers.ts
import { getAuth } from '@/lib/auth.config';
import { query } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export async function requireAuth(
  request: NextRequest,
  requireAdmin = false
) {
  const { env } = getCloudflareContext();
  const { auth, ready } = getAuth(env);
  await ready;

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.email) {
    return { error: 'Unauthorized', status: 401 };
  }

  if (requireAdmin) {
    const userResult = await query(
      `SELECT username, roles FROM pirates WHERE pirate_id = $1`,
      [session.user.id],
      env
    );

    const user = userResult.rows[0];
    const isAdmin = user?.roles?.includes('admin') || user?.username === 'admin';

    if (!isAdmin) {
      return { error: 'Forbidden', status: 403 };
    }

    return { user: { ...user, id: session.user.id }, session };
  }

  return { user: { id: session.user.id, email: session.user.email }, session };
}

// Usage
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, true);

  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  // Proceed with authResult.user
}
```

## Role Management

### Assigning Admin Role

Create a SQL script:

```sql
-- scripts/set-admin.sql
UPDATE pirates
SET roles = ARRAY['admin']
WHERE email = 'user@example.com';
```

Execute:

```bash
cd apps/web
npm run db:execute -- scripts/set-admin.sql
```

### Checking Roles

```sql
-- Check user's roles
SELECT pirate_id, username, email, roles FROM pirates WHERE email = 'user@example.com';

-- Find all admins
SELECT * FROM pirates WHERE 'admin' = ANY(roles);

-- Add role to existing user
UPDATE pirates
SET roles = array_append(roles, 'moderator')
WHERE email = 'user@example.com';

-- Remove role
UPDATE pirates
SET roles = array_remove(roles, 'moderator')
WHERE email = 'user@example.com';
```

## User Profile

### Profile Page

**Route:** `/profile`

**Features:**
- View user information
- Update username
- Update profile image
- Change password (email/password users only)
- Linked accounts display

### Context Provider

**Location:** `components/contexts/AuthContext.tsx`

```typescript
import { createAuthClient } from 'better-auth/react';

const authClient = createAuthClient();

export function AuthProvider({ children }) {
  return (
    <authClient.Provider>
      {children}
    </authClient.Provider>
  );
}

// Use in components
export function useAuth() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;

  return {
    user,
    isAuthenticated: !!user,
    isLoading: isPending,
    isAdmin: user?.roles?.includes('admin') || user?.username === 'admin',
  };
}
```

## Security Best Practices

### Password Requirements

```typescript
function validatePassword(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain an uppercase letter' };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain a lowercase letter' };
  }

  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain a number' };
  }

  return { valid: true };
}
```

### Session Refresh

```typescript
// Better Auth handles automatic refresh
// Session is valid for 7 days, refresh token every 1 day
```

### CSRF Protection

Better Auth includes built-in CSRF protection:

```typescript
// CSRF tokens are automatically included in:
// - Form submissions
// - AJAX requests with proper credentials
```

### Rate Limiting

Implement rate limiting for auth endpoints:

```typescript
import { Ratelimit } from "@unkey/ratelimit";

const ratelimit = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') ?? 'anonymous';
  const { success } = await ratelimit.limit(ip);

  if (!success) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    );
  }

  // Proceed with auth logic
}
```

## Related Files

- Auth Config: `apps/web/lib/auth.config.ts`
- Auth Context: `apps/web/components/contexts/AuthContext.tsx`
- Pirates Table: Defined in migrations
- Profile Page: `apps/web/app/profile/page.tsx`

## See Also

- [Database Operations](../ops/DATABASE.md) - User role assignment
- [Entity Cache System](ENTITY_CACHE_SYSTEM.md) - Admin entity publishing
- [Service Integration](SERVICE_INTEGRATION.md) - Authenticated service calls
