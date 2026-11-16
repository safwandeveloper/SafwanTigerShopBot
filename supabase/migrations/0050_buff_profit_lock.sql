-- Buff Token (TunVN), Buff Freebies and supplier profit lock.
-- Additive only: new nullable columns, one new table, one new function.
-- No existing rows are updated or deleted when this file runs.

-- Profit lock: when set, supplier price sync keeps
-- local price = supplier cost + locked_profit. NULL = off (old behaviour).
alter table public.supplier_product_links
    add column if not exists locked_profit numeric(12,4);

-- Buff Freebie: when set, a claim orders this many billion Buff tokens
-- (1-30) for the claimer's invite code. NULL = normal freebie.
alter table public.freebies
    add column if not exists buff_qty int check (buff_qty is null or (buff_qty between 1 and 30));

create table if not exists public.buff_orders (
    id                  bigserial primary key,
    user_id             bigint not null,
    channel             text not null default 'bot' check (channel in ('bot', 'api', 'freebie')),
    supplier_id         bigint,
    order_id            bigint,
    freebie_claim_id    bigint,
    orders_text         text not null,
    total_qty           int not null default 0,
    supplier_cost_usdt  numeric(14,4),
    price_usdt          numeric(14,4) not null default 0,
    refunded_usdt       numeric(14,4) not null default 0,
    status              text not null default 'pending'
                        check (status in ('pending', 'placed', 'done', 'failed', 'refunded', 'partial_refund', 'needs_check')),
    batch_id            text,
    supplier_response   jsonb,
    error               text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists buff_orders_user_idx on public.buff_orders(user_id, created_at desc);
create index if not exists buff_orders_open_idx on public.buff_orders(status, created_at)
    where status in ('placed', 'needs_check');

alter table public.buff_orders enable row level security;
grant all on public.buff_orders to service_role;
grant usage, select on sequence public.buff_orders_id_seq to service_role;

-- Undo a freebie claim whose Buff order failed: removes the claim and
-- gives the stock / item back, so a failed order never uses up a claim.
create or replace function public.release_freebie_claim(p_claim_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_claim public.freebie_claims;
    v_freebie public.freebies;
begin
    select * into v_claim from public.freebie_claims where id = p_claim_id for update;
    if not found then
        return;
    end if;
    select * into v_freebie from public.freebies where id = v_claim.freebie_id for update;
    if v_claim.item_id is not null then
        update public.freebie_items
           set claimed_by = null, claimed_at = null
         where id = v_claim.item_id;
    elsif found and v_freebie.delivery_mode = 'content' and v_freebie.stock is not null then
        update public.freebies
           set stock = stock + 1, updated_at = now()
         where id = v_freebie.id;
    end if;
    delete from public.freebie_claims where id = p_claim_id;
end;
$$;

grant execute on function public.release_freebie_claim(bigint) to service_role;
