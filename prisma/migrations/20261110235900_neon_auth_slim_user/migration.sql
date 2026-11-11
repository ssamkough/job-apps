-- Authentication moves to Neon Auth (Better Auth). Credentials, email, name,
-- sessions and one-time codes now live in the `neon_auth` schema, so the app
-- keeps only a slim User row (id = Neon Auth user id) for its own foreign keys.
--
-- Production had no users when this ran. A development database that still has
-- users from the old password auth keeps their rows (and their applications),
-- but those users can no longer sign in: ids are now Neon Auth uuids. Wipe such
-- a database with TRUNCATE rather than trying to migrate it.

-- DropTable
DROP TABLE "AuthToken";

-- DropTable
DROP TABLE "Session";

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "email",
DROP COLUMN "emailVerifiedAt",
DROP COLUMN "name",
DROP COLUMN "passwordHash";
