-- Daily cap on rewarded verified referrals per referrer.
-- Additive only: adds a new function complete_human_verification_v2.
-- The original complete_human_verification is left untouched.
-- No DROP / DELETE / UPDATE of existing data.

create or replace function public.complete_human_verification_v2(
    p_user_id bigint,
    p_ip_hash text,
    p_device_hash text,
    p_ip_limit int,
    p_ref_reward numeric,
    p_user_bonus numeric,
    p_daily_limit int
)
returns table (
    status text,
    referrer_id bigint,
    referral_created boolean,
    new_balance numeric,
    referrer_limited boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_row public.human_verifications%rowtype;
    v_ip_count int;
    v_today int;
    v_created boolean := false;
    v_limited boolean := false;
    v_reward numeric := p_ref_reward;
    v_balance numeric;
    v_status text;
    v_day_start timestamptz :=
        date_trunc('day', now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';
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
        return query select v_row.status, v_row.referrer_id, false, null::numeric, false;
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
            perform pg_advisory_xact_lock(hashtext('hv_ref:' || v_row.referrer_id::text));
            if coalesce(p_daily_limit, 0) > 0 then
                select count(*)::int into v_today
                  from public.human_verifications h
                 where h.referrer_id = v_row.referrer_id
                   and h.status = 'verified'
                   and coalesce(h.ref_reward, 0) > 0
                   and h.verified_at >= v_day_start;
                if v_today >= p_daily_limit then
                    v_limited := true;
                    v_reward := 0;
                end if;
            end if;
            if not v_limited then
                insert into public.referrals (referrer_id, referee_id, reward_usd)
                values (v_row.referrer_id, p_user_id, p_ref_reward)
                on conflict (referrer_id, referee_id) do nothing;
                v_created := found;
            end if;
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
           ref_reward = case when v_status = 'verified' then v_reward end,
           user_bonus = case when v_status = 'verified' then p_user_bonus end,
           verified_at = case when v_status = 'verified' then now() end,
           updated_at = now()
     where h.user_id = p_user_id;

    return query select v_status, v_row.referrer_id, v_created, v_balance, v_limited;
end;
$$;

grant execute on function public.complete_human_verification_v2(bigint, text, text, int, numeric, numeric, int) to service_role;
