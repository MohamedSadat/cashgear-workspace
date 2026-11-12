using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class ReadCommittedSnapshot : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Reads see the last committed version of a row instead of waiting for its writer
            // (DECISIONS.md, Phase 3: the worker's lag): under the 200-person load test, readers
            // waiting on writers' locks were the largest wait. The change feed's guarantee holds,
            // as sequences are still given out and committed in order under the workspace's lock.
            // Not in a transaction (ALTER DATABASE cannot be); other sessions' open transactions
            // are rolled back so the change can be made while the old version still runs.
            migrationBuilder.Sql("ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;", suppressTransaction: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", suppressTransaction: true);
        }
    }
}
