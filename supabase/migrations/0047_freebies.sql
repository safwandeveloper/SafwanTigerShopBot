-- Freebies: admin-managed free items users can claim from Refer & Earn.
-- Additive only: creates new tables + one RPC; existing tables untouched.

create table if not exists public.freebies (
    id              bigserial primary key,
    name            text not null,
    emoji_id        text,
    kind            text not null default 'Resources',
    description     text,
    -- 'content': every claim receives `content`; 'items': each claim takes one row from freebie_items.
    delivery_mode   text not null default 'content' check (delivery_mode in ('content', 'items')),
    content         text,
    -- Remaining claims for 'content' mode; null = unlimited. Ignored in 'items' mode.
    stock           int check (stock is null or stock >= 0),
    -- Max claims per user; 0 = unlimited.
    per_user_limit  int not null default 1 check (per_user_limit >= 0),
    min_refs        int not null default 0 check (min_refs >= 0),
    button_label    text,
    button_color    text not null default 'none',
    button_icon_id  text,
    active          boolean not null default false,
    sort_order      int not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists public.freebie_items (
    id          bigserial primary key,
    freebie_id  bigint not null references public.freebies(id) on delete cascade,
    payload     text not null,
    claimed_by  bigint,
    claimed_at  timestamptz,
    created_at  timestamptz not null default now()
);

create index if not exists freebie_items_unclaimed_idx
    on public.freebie_items(freebie_id, id) where claimed_at is null;

create table if not exists public.freebie_claims (
    id          bigserial primary key,
    freebie_id  bigint not null references public.freebies(id) on delete cascade,
    user_id     bigint not null,
    item_id     bigint references public.freebie_items(id) on delete set null,
    delivered   text,
    claimed_at  timestamptz not null default now()
);

create index if not exists freebie_claims_user_idx
    on public.freebie_claims(freebie_id, user_id);

-- Atomic claim: checks active flag, per-user limit and stock, then records the claim.
create or replace function public.claim_freebie(
    p_freebie_id bigint,
    p_user_id bigint
)
returns table (claim_id bigint, delivered text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_freebie public.freebies;
    v_used int;
    v_item public.freebie_items;
    v_delivered text;
    v_claim_id bigint;
begin
    perform pg_advisory_xact_lock(hashtext('freebie_claim:' || p_user_id::text));

    select * into v_freebie from public.freebies where id = p_freebie_id for update;
    if not found or not v_freebie.active then
        raise exception 'FREEBIE_INACTIVE';
    end if;

    select count(*)::int into v_used
      from public.freebie_claims
     where freebie_id = p_freebie_id and user_id = p_user_id;
    if v_freebie.per_user_limit > 0 and v_used >= v_freebie.per_user_limit then
        raise exception 'FREEBIE_LIMIT';
    end if;

    if v_freebie.delivery_mode = 'items' then
        select * into v_item
          from public.freebie_items
         where freebie_id = p_freebie_id and claimed_at is null
         order by id
         limit 1
         for update skip locked;
        if not found then
            raise exception 'FREEBIE_OUT';
        end if;
        update public.freebie_items
           set claimed_by = p_user_id, claimed_at = now()
         where id = v_item.id;
        v_delivered := v_item.payload;
    else
        if v_freebie.stock is not null then
            if v_freebie.stock <= 0 then
                raise exception 'FREEBIE_OUT';
            end if;
            update public.freebies
               set stock = stock - 1, updated_at = now()
             where id = p_freebie_id;
        end if;
        v_delivered := v_freebie.content;
    end if;

    insert into public.freebie_claims (freebie_id, user_id, item_id, delivered)
    values (p_freebie_id, p_user_id, v_item.id, v_delivered)
    returning id into v_claim_id;

    return query select v_claim_id, v_delivered;
end;
$$;

grant execute on function public.claim_freebie(bigint, bigint) to service_role;
