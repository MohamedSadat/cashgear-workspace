using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase17Workflows : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "ApprovalId",
                table: "Notifications",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "WatchesRows",
                table: "Automations",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Context",
                table: "AutomationRuns",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Definition",
                table: "AutomationRuns",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Place",
                table: "AutomationRuns",
                type: "varchar(40)",
                unicode: false,
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "TakenAt",
                table: "AutomationRuns",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "WaitKind",
                table: "AutomationRuns",
                type: "varchar(10)",
                unicode: false,
                maxLength: 10,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "WaitUntil",
                table: "AutomationRuns",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "WaitedAt",
                table: "AutomationRuns",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "AutomationApprovals",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RunId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    AutomationId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RowId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    StepPath = table.Column<string>(type: "varchar(40)", unicode: false, maxLength: 40, nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Mode = table.Column<string>(type: "varchar(4)", unicode: false, maxLength: 4, nullable: false),
                    Answer = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: true),
                    Comment = table.Column<string>(type: "nvarchar(1000)", maxLength: 1000, nullable: true),
                    AnsweredAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    DeadlineAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    Outcome = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AutomationApprovals", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_Waiting",
                table: "AutomationRuns",
                column: "WaitUntil",
                filter: "[Status] = 'waiting'")
                .Annotation("SqlServer:Include", new[] { "TakenAt" });

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_WaitingRows",
                table: "AutomationRuns",
                column: "RowId",
                filter: "[Status] = 'waiting' AND [RowId] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "WaitKind" });

            migrationBuilder.CreateIndex(
                name: "IX_AutomationApprovals_RunId_StepPath_UserId",
                table: "AutomationApprovals",
                columns: new[] { "RunId", "StepPath", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AutomationApprovals_UserId_CreatedAt",
                table: "AutomationApprovals",
                columns: new[] { "UserId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AutomationApprovals");

            migrationBuilder.DropIndex(
                name: "IX_AutomationRuns_Waiting",
                table: "AutomationRuns");

            migrationBuilder.DropIndex(
                name: "IX_AutomationRuns_WaitingRows",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "ApprovalId",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "WatchesRows",
                table: "Automations");

            migrationBuilder.DropColumn(
                name: "Context",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "Definition",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "Place",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "TakenAt",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "WaitKind",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "WaitUntil",
                table: "AutomationRuns");

            migrationBuilder.DropColumn(
                name: "WaitedAt",
                table: "AutomationRuns");
        }
    }
}
