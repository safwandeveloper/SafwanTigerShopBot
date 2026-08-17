-- Award 0.10 USDT to a referrer for every 3 active referrals.

create table if not exists public.referral_milestone_rewards (
    id          bigserial primary key,
    user_id     bigint not null references public.users(telegram_id) on delete cascade,
    milestone  integer not null check (milestone > 0),
    amount     numeric(14,2) not null check (amount > 0),
    created_at timestamptz not null default now(),
    unique (user_id, milestone)
);

create index if not exists referral_milestone_rewards_user_idx
    on public.referral_milestone_rewards(user_id, created_at desc);

alter table public.referral_milestone_rewards enable row level security;

create or replace function public.award_referral_milestones(p_user_id bigint)
returns table (
    awarded_count integer,
    awarded_amount numeric,
    new_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_active_count integer;
    v_target_milestone integer;
    v_next_milestone integer;
    v_awarded_count integer := 0;
    v_awarded_amount numeric := 0;
    v_balance numeric;
begin
    select balance
      into v_balance
      from public.users
     where telegram_id = p_user_id
     for update;

    if not found then
        return query select 0, 0::numeric, 0::numeric;
        return;
    end if;

    select count(*)::integer
      into v_active_count
      from public.referrals
     where referrer_id = p_user_id;

    v_target_milestone := floor(v_active_count / 3.0)::integer;
    select coalesce(max(milestone), 0) + 1
      into v_next_milestone
      from public.referral_milestone_rewards
     where user_id = p_user_id;

    while v_next_milestone <= v_target_milestone loop
        insert into public.referral_milestone_rewards(user_id, milestone, amount)
        values (p_user_id, v_next_milestone, 0.10)
        on conflict (user_id, milestone) do nothing;

        if found then
            v_balance := v_balance + 0.10;
            v_awarded_count := v_awarded_count + 1;
            v_awarded_amount := v_awarded_amount + 0.10;
            insert into public.wallet_ledger(user_id, type, amount, reference)
            values (
                p_user_id,
                'referral_milestone_reward',
                0.10,
                'referral_milestone:' || v_next_milestone::text
            );
        end if;
        v_next_milestone := v_next_milestone + 1;
    end loop;

    if v_awarded_count > 0 then
        update public.users
           set balance = v_balance
         where telegram_id = p_user_id;
    end if;

    return query select v_awarded_count, v_awarded_amount, v_balance;
end;
$$;

revoke all on function public.award_referral_milestones(bigint) from public;
grant execute on function public.award_referral_milestones(bigint) to service_role;
