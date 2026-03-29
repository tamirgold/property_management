# SQL Migrations

Place ordered `.sql` files in this directory (for example `001_init.sql`, `002_add_index.sql`).

`npm run migrate` applies all files in lexical order using `psql` and `DATABASE_URL`.
