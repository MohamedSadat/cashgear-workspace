using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase8Mail : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "EmailedAt",
                table: "Notifications",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "MailId",
                table: "Notifications",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "MailOutbox",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Kind = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    NextAttemptAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    SentAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    Outcome = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: true),
                    EndedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    LastError = table.Column<string>(type: "varchar(200)", unicode: false, maxLength: 200, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MailOutbox", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MailSettings",
                columns: table => new
                {
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Mode = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    Stamp = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    OnSince = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    LastMailAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MailSettings", x => x.UserId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_MailDue",
                table: "Notifications",
                column: "CreatedAt",
                filter: "[ReadAt] IS NULL AND [MailId] IS NULL AND [EmailedAt] IS NULL")
                .Annotation("SqlServer:Include", new[] { "UserId", "Kind" });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_MailId",
                table: "Notifications",
                column: "MailId",
                filter: "[MailId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_MailOutbox_SentAt",
                table: "MailOutbox",
                column: "SentAt",
                filter: "[SentAt] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_MailOutbox_UserId",
                table: "MailOutbox",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_MailOutbox_Waiting",
                table: "MailOutbox",
                column: "NextAttemptAt",
                filter: "[Outcome] IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MailOutbox");

            migrationBuilder.DropTable(
                name: "MailSettings");

            migrationBuilder.DropIndex(
                name: "IX_Notifications_MailDue",
                table: "Notifications");

            migrationBuilder.DropIndex(
                name: "IX_Notifications_MailId",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "EmailedAt",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "MailId",
                table: "Notifications");
        }
    }
}
