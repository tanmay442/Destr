# One customer per deployment

Destr is single-tenant by deployment. Each customer must use a separate Clerk instance, Postgres database, blob store, Redis data set, and queue configuration because documents, settings, administration, and analytics are deployment-wide. Shared-database multi-tenancy was rejected because optional tenant identifiers would not enforce isolation across every query, cache key, storage key, and background job.
