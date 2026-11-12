using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class PurgeAndHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PurgedAt",
                table: "Pages",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Pages_DeletedAt",
                table: "Pages",
                column: "DeletedAt",
                filter: "[DeletedAt] IS NOT NULL AND [PurgedAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_PageDocSnapshots_Status_CreatedAt",
                table: "PageDocSnapshots",
                columns: new[] { "Status", "CreatedAt" },
                filter: "[Status] = 'pending'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Pages_DeletedAt",
                table: "Pages");

            migrationBuilder.DropIndex(
                name: "IX_PageDocSnapshots_Status_CreatedAt",
                table: "PageDocSnapshots");

            migrationBuilder.DropColumn(
                name: "PurgedAt",
                table: "Pages");
        }
    }
}
