-- A title that answers 500 must not be able to stop the whole run, and must not
-- be retried forever either.
alter table titles add column tries integer not null default 0;
drop index if exists titles_kp_pending;
create index if not exists titles_kp_pending on titles (rank) where kp is null;
