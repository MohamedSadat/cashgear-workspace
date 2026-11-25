using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase17Reminders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "DateStart",
                table: "Notifications",
                type: "varchar(40)",
                unicode: false,
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PropertyId",
                table: "Notifications",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Reminders",
                table: "Databases",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "SeriesDay",
                table: "Automations",
                type: "varchar(10)",
                unicode: false,
                maxLength: 10,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SeriesNext",
                table: "Automations",
                type: "varchar(10)",
                unicode: false,
                maxLength: 10,
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "SeriesRowId",
                table: "Automations",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "RowReminders",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RowId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PropertyId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BeforeMinutes = table.Column<int>(type: "int", nullable: false),
                    DueAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    SentFor = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RowReminders", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RowReminders_Due",
                table: "RowReminders",
                column: "DueAt",
                filter: "[DueAt] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "SentFor" });

            migrationBuilder.CreateIndex(
                name: "IX_RowReminders_RowId",
                table: "RowReminders",
                column: "RowId");

            migrationBuilder.CreateIndex(
                name: "IX_RowReminders_UserId_RowId_PropertyId",
                table: "RowReminders",
                columns: new[] { "UserId", "RowId", "PropertyId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RowReminders");

            migrationBuilder.DropColumn(
                name: "DateStart",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "PropertyId",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "Reminders",
                table: "Databases");

            migrationBuilder.DropColumn(
                name: "SeriesDay",
                table: "Automations");

            migrationBuilder.DropColumn(
                name: "SeriesNext",
                table: "Automations");

            migrationBuilder.DropColumn(
                name: "SeriesRowId",
                table: "Automations");
        }
    }
}
