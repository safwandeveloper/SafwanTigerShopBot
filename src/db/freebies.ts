/**
 * Freebies — admin-managed free items users claim from Refer & Earn.
 * Tables: freebies, freebie_items, freebie_claims (migration 0047).
 */
import { supabase } from './supabase.js';
import { logger } from '../logger.js';

export type FreebieMode = 'content' | 'items';

export type DBFreebie = {
  id: number;
  name: string;
  emoji_id: string | null;
  kind: string;
  description: string | null;
  delivery_mode: FreebieMode;
  content: string | null;
  stock: number | null;
  per_user_limit: number;
  min_refs: number;
  button_label: string | null;
  button_color: string;
  button_icon_id: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type DBFreebieClaim = {
  id: number;
  freebie_id: number;
  user_id: number;
  item_id: number | null;
  delivered: string | null;
  claimed_at: string;
};

export type FreebiePatch = Partial<
  Pick<
    DBFreebie,
    | 'name'
    | 'emoji_id'
    | 'kind'
    | 'description'
    | 'delivery_mode'
    | 'content'
    | 'stock'
    | 'per_user_limit'
    | 'min_refs'
    | 'button_label'
    | 'button_color'
    | 'button_icon_id'
    | 'active'
  >
>;

export type FreebieClaimError = 'FREEBIE_INACTIVE' | 'FREEBIE_LIMIT' | 'FREEBIE_OUT';

export class FreebieClaimFailed extends Error {
  constructor(public readonly code: FreebieClaimError) {
    super(code);
    this.name = 'FreebieClaimFailed';
  }
}

export async function listFreebies(onlyActive: boolean): Promise<DBFreebie[]> {
  let q = supabase.from('freebies').select('*');
  if (onlyActive) q = q.eq('active', true);
  const { data, error } = await q.order('sort_order', { ascending: true }).order('id', { ascending: true });
  if (error) {
    logger.error({ err: error }, 'listFreebies failed');
    throw error;
  }
  return (data ?? []) as DBFreebie[];
}

export async function getFreebie(id: number): Promise<DBFreebie | null> {
  const { data, error } = await supabase.from('freebies').select('*').eq('id', id).maybeSingle();
  if (error) {
    logger.error({ err: error, id }, 'getFreebie failed');
    throw error;
  }
  return (data ?? null) as DBFreebie | null;
}

export async function createFreebie(name: string): Promise<DBFreebie> {
  const { data, error } = await supabase.from('freebies').insert({ name, kind: 'FreeBie' }).select('*').single();
  if (error) {
    logger.error({ err: error }, 'createFreebie failed');
    throw error;
  }
  return data as DBFreebie;
}

export async function updateFreebie(id: number, patch: FreebiePatch): Promise<void> {
  const { error } = await supabase
    .from('freebies')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    logger.error({ err: error, id }, 'updateFreebie failed');
    throw error;
  }
}

export async function deleteFreebie(id: number): Promise<void> {
  const { error } = await supabase.from('freebies').delete().eq('id', id);
  if (error) {
    logger.error({ err: error, id }, 'deleteFreebie failed');
    throw error;
  }
}

export async function countUnclaimedFreebieItems(freebieId: number): Promise<number> {
  const { count, error } = await supabase
    .from('freebie_items')
    .select('id', { count: 'exact', head: true })
    .eq('freebie_id', freebieId)
    .is('claimed_at', null);
  if (error) {
    logger.error({ err: error, freebieId }, 'countUnclaimedFreebieItems failed');
    throw error;
  }
  return count ?? 0;
}

export async function addFreebieItems(freebieId: number, payloads: string[]): Promise<number> {
  if (payloads.length === 0) return 0;
  const { error } = await supabase
    .from('freebie_items')
    .insert(payloads.map((payload) => ({ freebie_id: freebieId, payload })));
  if (error) {
    logger.error({ err: error, freebieId }, 'addFreebieItems failed');
    throw error;
  }
  return payloads.length;
}

/** Removes only unclaimed pool rows; claimed rows stay for history. */
export async function clearUnclaimedFreebieItems(freebieId: number): Promise<number> {
  const { count, error } = await supabase
    .from('freebie_items')
    .delete({ count: 'exact' })
    .eq('freebie_id', freebieId)
    .is('claimed_at', null);
  if (error) {
    logger.error({ err: error, freebieId }, 'clearUnclaimedFreebieItems failed');
    throw error;
  }
  return count ?? 0;
}

export async function countFreebieClaims(freebieId: number, userId?: number): Promise<number> {
  let q = supabase
    .from('freebie_claims')
    .select('id', { count: 'exact', head: true })
    .eq('freebie_id', freebieId);
  if (userId !== undefined) q = q.eq('user_id', userId);
  const { count, error } = await q;
  if (error) {
    logger.error({ err: error, freebieId, userId }, 'countFreebieClaims failed');
    throw error;
  }
  return count ?? 0;
}

export async function listFreebieClaims(freebieId: number, limit = 20): Promise<DBFreebieClaim[]> {
  const { data, error } = await supabase
    .from('freebie_claims')
    .select('*')
    .eq('freebie_id', freebieId)
    .order('claimed_at', { ascending: false })
    .limit(limit);
  if (error) {
    logger.error({ err: error, freebieId }, 'listFreebieClaims failed');
    throw error;
  }
  return (data ?? []) as DBFreebieClaim[];
}

/** Remaining claims: null = unlimited. */
export async function freebieRemaining(f: DBFreebie): Promise<number | null> {
  if (f.delivery_mode === 'items') return countUnclaimedFreebieItems(f.id);
  return f.stock;
}

export async function claimFreebie(
  freebieId: number,
  userId: number,
): Promise<{ claimId: number; delivered: string | null }> {
  const { data, error } = await supabase.rpc('claim_freebie', {
    p_freebie_id: freebieId,
    p_user_id: userId,
  });
  if (error) {
    for (const code of ['FREEBIE_INACTIVE', 'FREEBIE_LIMIT', 'FREEBIE_OUT'] as const) {
      if (error.message.includes(code)) throw new FreebieClaimFailed(code);
    }
    logger.error({ err: error, freebieId, userId }, 'claimFreebie failed');
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claim_id?: number; delivered?: string | null }
    | null;
  return { claimId: Number(row?.claim_id ?? 0), delivered: row?.delivered ?? null };
}
