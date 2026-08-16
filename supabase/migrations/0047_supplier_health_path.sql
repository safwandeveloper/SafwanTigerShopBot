-- Optional liveness endpoint used by preset supplier connectors.

alter table public.supplier_api_sources
    add column if not exists health_path text not null default '';
