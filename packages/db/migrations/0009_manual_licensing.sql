-- 0009 — Monthly licensing with manual payment confirmation.
--
-- Business model (launch-gate amendment): payments arrive by bank transfer or
-- through Chariow / Maketou; an administrator verifies actual receipt and only
-- then does the subscription activate or extend. No Stripe, no aggregator, no
-- card processing. Entitlement is decided server-side from these tables — a
-- login, a screenshot or a client declaration proves nothing.
--
-- Tenant model: the subscription belongs to the WORKSPACE (the existing
-- tenant), not to an individual user. One subscription per workspace per
-- product; renewals EXTEND expires_at (history lives in audit_log).

-- ------------------------------------------------------------ product registry
create table products (
  id         text primary key,              -- stable server-controlled id
  name       text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

insert into products (id, name) values ('revenue_recovery_os', 'Revenue Recovery OS');

-- ------------------------------------------------- trusted platform admin flag
-- NOT the workspace 'admin' role: this is the operator who confirms payments.
-- Never settable through the application: the app role's UPDATE grant on users
-- becomes column-scoped below, and is_platform_admin is simply not in the list.
alter table users add column if not exists is_platform_admin boolean not null default false;

-- ---------------------------------------------------------------- subscriptions
create table subscriptions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  product_id   text not null references products(id),
  status       text not null default 'pending'
               check (status in ('pending','active','expired','suspended','cancelled')),
  starts_at    timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, product_id)       -- one entitlement per tenant & product
);
create index subscriptions_workspace_idx on subscriptions (workspace_id);
create index subscriptions_status_idx on subscriptions (status, expires_at);

-- --------------------------------------------------------------------- payments
create table payments (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  subscription_id   uuid not null references subscriptions(id) on delete cascade,
  plan              text not null check (plan in ('starter','growth','scale')),
  amount_cents      bigint not null check (amount_cents > 0),
  currency          text not null check (currency in ('EUR','XAF')),
  payment_method    text not null check (payment_method in ('bank_transfer','chariow','maketou')),
  external_reference text,
  status            text not null default 'pending'
                    check (status in ('pending','confirmed','rejected','refunded')),
  rejection_reason  text,
  submitted_by      uuid not null references users(id),
  validated_by      uuid references users(id),
  validated_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index payments_workspace_idx on payments (workspace_id);
create index payments_pending_idx on payments (status, created_at) where status = 'pending';
-- One external reference per channel: a resubmitted bank slip cannot confirm twice.
create unique index payments_external_ref_unique
  on payments (payment_method, external_reference)
  where external_reference is not null;

-- ------------------------------------------------------- row level security
alter table products      enable row level security;
alter table subscriptions enable row level security;
alter table payments      enable row level security;

create policy products_readable on products for select to app_authenticated using (true);
-- Customers read their own subscription and may list it, but never write it.
create policy tenant_isolation on subscriptions
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on payments
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

-- ------------------------------------------------------------------ privileges
-- The application role never mutates subscriptions or the product registry:
-- activation/extension/suspension run as the platform-admin server path, which
-- is the only holder of the licensing role.
grant select on products to app_authenticated;
grant select on subscriptions to app_authenticated;
grant select, insert on payments to app_authenticated;

-- Column-scoped user updates: is_platform_admin cannot be flipped by the app
-- role, RLS or no RLS.
revoke update on users from app_authenticated;
grant update (email, full_name, role, last_seen_at) on users to app_authenticated;
