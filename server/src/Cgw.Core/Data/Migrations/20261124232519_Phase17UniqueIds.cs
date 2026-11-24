using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase17UniqueIds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "NextNumber",
                table: "Databases",
                type: "bigint",
                nullable: false,
                defaultValue: 1L);

            migrationBuilder.AddColumn<long>(
                name: "Number",
                table: "DatabaseRows",
                type: "bigint",
                nullable: true);

            // Every row stored before 0.17.0 numbered in the order it was made, before the index holds them.
            migrationBuilder.Sql(Cgw.Core.Databases.UniqueIds.BackfillSql);

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseRows_Number",
                table: "DatabaseRows",
                columns: new[] { "DatabaseId", "Number" },
                unique: true,
                filter: "[Number] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_DatabaseRows_Number",
                table: "DatabaseRows");

            migrationBuilder.DropColumn(
                name: "NextNumber",
                table: "Databases");

            migrationBuilder.DropColumn(
                name: "Number",
                table: "DatabaseRows");
        }
    }
}
