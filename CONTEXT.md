# Destr

Destr provides one deployment-wide knowledge corpus and support workflow for the users of one customer deployment.

## Language

**Deployment**:
One isolated Destr installation with its own identity provider, database, blob storage, Redis data, queue configuration, and knowledge corpus.
_Avoid_: Tenant, workspace, organization

**Knowledge corpus**:
The deployment-wide collection of documents available to every signed-in user for retrieval.
_Avoid_: Tenant corpus, workspace library

**User**:
A person signed in to the deployment. Saved conversations and feedback belong to that user.
_Avoid_: Member, tenant user

**Admin**:
A user who can manage the deployment-wide corpus, users, tickets, settings, audit data, and analytics.
_Avoid_: Workspace owner, organization admin
