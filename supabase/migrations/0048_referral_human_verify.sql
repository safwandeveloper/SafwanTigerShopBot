-- =====================================================================
-- 0048_referral_human_verify.sql
--
-- Human verification for referred users (additive only).
--   * human_verifications: one row per referred new user that was asked
--     to verify. Stores only HMAC hashes of the IP / device id.
--   * referrals.reward_usd: nullable value of a referral. Existing rows
--     stay NULL and keep the legacy value ($0.02) - no rows are updated.
--   * complete_human_verification(): atomic verify + rewards.
--   * referral_value_summary() / convert_referral_value_to_wallet():
--     value-aware referral balance (oldest refs are spent first).
-- No DROP / DELETE / UPDATE of existing data.
-- =====================================================================

create table if not exists public.human_verifications (
    user_id      bigint primary key references public.users(telegram_id) on delete cascade,
    referrer_id  bigint references public.users(telegram_id) on delete set null,
    status       text not null default 'pending'
                 check (status in ('pending','verified','skipped','ip_limited','device_dup','failed')),
    attempts     int not null default 0,
    ip_hash      text,
    device_hash  text,
    ref_reward   numeric(10,4),
    user_bonus   numeric(10,4),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    verified_at  timestamptz
);

create index if not exists human_verifications_ip_idx
    on public.human_verifications(ip_hash) where status = 'verified';
create index if not exists human_verifications_device_idx
    on public.human_verifications(device_hash) where status = 'verified';
create index if not exists human_verifications_referrer_idx
    on public.human_verifications(referrer_id, verified_at desc);

alter table public.human_verifications enable row level security;

alter table public.referrals
    add column if not exists reward_usd numeric(10,4);

-- ---------------------------------------------------------------------
-- Count a wrong answer. Marks the row failed after p_max attempts.
-- ---------------------------------------------------------------------
create or replace function public.record_human_verify_attempt(
    p_user_id bigint,
    p_max int
)
returns table (status text, attempts int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_row public.human_verifications%rowtype;
begin
    select * into v_row from public.human_verifications
     where user_id = p_user_id for update;
    if not found then
        raise exception 'VERIFICATION_NOT_FOUND';
    end if;
    if v_row.status <> 'pending' then
        return query select v_row.status, v_row.attempts;
        return;
    end if;
    update public.human_verifications h
       set attempts = h.attempts + 1,
           status = case when h.attempts + 1 >= p_max then 'failed' else 'pending' end,
           updated_at = now()
     where h.user_id = p_user_id
     returning h.status, h.attempts into v_row.status, v_row.attempts;
    return query select v_row.status, v_row.attempts;
end;
$$;

-- ---------------------------------------------------------------------
-- Atomically complete a verification: device lock, IP limit, then
-- credit the referral (reward_usd) and the new-user wallet bonus once.
-- ---------------------------------------------------------------------
create or replace function public.complete_human_verification(
    p_user_id bigint,
    p_ip_hash text,
    p_device_hash text,
    p_ip_limit int,
    p_ref_reward numeric,
    p_user_bonus numeric
)
returns table (status text, referrer_id bigint, referral_created boolean, new_balance numeric)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_row public.human_verifications%rowtype;
    v_ip_count int;
    v_created boolean := false;
    v_balance numeric;
    v_status text;
begin
    if p_ip_hash is not null then
        perform pg_advisory_xact_lock(hashtext('hv_ip:' || p_ip_hash));
    end if;
    if p_device_hash is not null then
        perform pg_advisory_xact_lock(hashtext('hv_dev:' || p_device_hash));
    end if;

    select * into v_row from public.human_verifications
     where user_id = p_user_id for update;
    if not found then
        raise exception 'VERIFICATION_NOT_FOUND';
    end if;
    if v_row.status <> 'pending' then
        return query select v_row.status, v_row.referrer_id, false, null::numeric;
        return;
    end if;

    if p_device_hash is not null and exists (
        select 1 from public.human_verifications h
         where h.device_hash = p_device_hash
           and h.status = 'verified'
           and h.user_id <> p_user_id
    ) then
        v_status := 'device_dup';
    else
        select count(*)::int into v_ip_count
          from public.human_verifications h
         where h.ip_hash = p_ip_hash
           and h.status = 'verified'
           and h.user_id <> p_user_id;
        if p_ip_hash is not null and v_ip_count >= greatest(p_ip_limit, 1) then
            v_status := 'ip_limited';
        else
            v_status := 'verified';
        end if;
    end if;

    if v_status = 'verified' then
        if v_row.referrer_id is not null and v_row.referrer_id <> p_user_id then
            insert into public.referrals (referrer_id, referee_id, reward_usd)
            values (v_row.referrer_id, p_user_id, p_ref_reward)
            on conflict (referrer_id, referee_id) do nothing;
            v_created := found;
        end if;
        if coalesce(p_user_bonus, 0) > 0 then
            update public.users
               set balance = coalesce(balance, 0) + p_user_bonus
             where telegram_id = p_user_id
             returning balance into v_balance;
            insert into public.wallet_ledger (user_id, type, amount, reference)
            values (p_user_id, 'verify_bonus', p_user_bonus, 'human_verify');
        end if;
    end if;

    update public.human_verifications h
       set status = v_status,
           ip_hash = p_ip_hash,
           device_hash = p_device_hash,
           ref_reward = case when v_status = 'verified' then p_ref_reward end,
           user_bonus = case when v_status = 'verified' then p_user_bonus end,
           verified_at = case when v_status = 'verified' then now() end,
           updated_at = now()
     where h.user_id = p_user_id;

    return query select v_status, v_row.referrer_id, v_created, v_balance;
end;
$$;

-- ---------------------------------------------------------------------
-- Value-aware referral balance. Spent refs consume the oldest refs
-- first, so the available refs are the newest ones. Legacy rows
-- (reward_usd is null) and admin adjustments use p_legacy_value.
-- ---------------------------------------------------------------------
create or replace function public.referral_value_summary(
    p_user_id bigint,
    p_legacy_value numeric
)
returns table (
    total_referrals int,
    spent_referrals int,
    available_referrals int,
    available_usd numeric,
    earned_usd numeric
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_rows int;
    v_adj int;
    v_total int;
    v_spent int;
    v_available int;
    v_avail_usd numeric;
    v_earned numeric;
begin
    select count(*)::int, coalesce(sum(coalesce(r.reward_usd, p_legacy_value)), 0)
      into v_rows, v_earned
      from public.referrals r where r.referrer_id = p_user_id;

    select coalesce(sum(delta), 0)::int into v_adj
      from public.referral_adjustments where user_id = p_user_id;

    v_total := greatest(0, v_rows + v_adj);

    select
        coalesce((select sum(referral_cost) from public.referral_redemptions where user_id = p_user_id), 0)::int
      + coalesce((select sum(refs_spent) from public.referral_conversions where user_id = p_user_id), 0)::int
      into v_spent;

    v_available := greatest(0, v_total - v_spent);

    select coalesce(sum(x.v), 0) into v_avail_usd
      from (
        select coalesce(r.reward_usd, p_legacy_value) as v
          from public.referrals r
         where r.referrer_id = p_user_id
         order by r.created_at desc, r.id desc
         limit v_available
      ) x;
    v_avail_usd := v_avail_usd + greatest(0, v_available - v_rows) * p_legacy_value;

    return query select v_total, v_spent, v_available,
        round(v_avail_usd, 2),
        round(greatest(0, v_earned + v_adj * p_legacy_value), 2);
end;
$$;

create or replace function public.convert_referral_value_to_wallet(
    p_user_id bigint,
    p_legacy_value numeric,
    p_min_usd numeric
)
returns table (refs_spent int, amount numeric, new_balance numeric)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_sum record;
    v_balance numeric;
begin
    perform pg_advisory_xact_lock(p_user_id);

    select * into v_sum from public.referral_value_summary(p_user_id, p_legacy_value);

    if v_sum.available_referrals <= 0
       or v_sum.available_usd <= 0
       or v_sum.available_usd < p_min_usd then
        raise exception 'INSUFFICIENT_REFERRALS';
    end if;

    insert into public.referral_conversions (user_id, refs_spent, amount)
    values (p_user_id, v_sum.available_referrals, v_sum.available_usd);

    update public.users
       set balance = coalesce(balance, 0) + v_sum.available_usd
     where telegram_id = p_user_id
     returning balance into v_balance;

    if v_balance is null then
        raise exception 'USER_NOT_FOUND';
    end if;

    return query select v_sum.available_referrals, v_sum.available_usd, v_balance;
end;
$$;

grant execute on function public.record_human_verify_attempt(bigint, int) to service_role;
grant execute on function public.complete_human_verification(bigint, text, text, int, numeric, numeric) to service_role;
grant execute on function public.referral_value_summary(bigint, numeric) to service_role;
grant execute on function public.convert_referral_value_to_wallet(bigint, numeric, numeric) to service_role;
