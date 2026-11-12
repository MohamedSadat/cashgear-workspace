using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <summary>
    /// Server search's full-text catalogue and index (Q7), only where the server has full-text
    /// search installed: <c>PageDocDerived.SearchText</c> with the neutral word breaker
    /// (LANGUAGE 0) and no stoplist, so Arabic and English words are split the same way and no
    /// word is dropped. Elsewhere (LocalDB) search uses LIKE on the same normalised columns.
    /// FULLTEXT DDL cannot run inside a transaction.
    /// </summary>
    public partial class SearchFullText : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                IF FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') = 1
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = N'cgw_search')
                        EXEC(N'CREATE FULLTEXT CATALOG cgw_search');
                    IF NOT EXISTS (SELECT 1 FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID(N'dbo.PageDocDerived'))
                        EXEC(N'CREATE FULLTEXT INDEX ON dbo.PageDocDerived (SearchText LANGUAGE 0) KEY INDEX PK_PageDocDerived ON cgw_search WITH (CHANGE_TRACKING = AUTO, STOPLIST = OFF)');
                END
                """,
                suppressTransaction: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                IF EXISTS (SELECT 1 FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID(N'dbo.PageDocDerived'))
                    EXEC(N'DROP FULLTEXT INDEX ON dbo.PageDocDerived');
                IF EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = N'cgw_search')
                    EXEC(N'DROP FULLTEXT CATALOG cgw_search');
                """,
                suppressTransaction: true);
        }
    }
}
