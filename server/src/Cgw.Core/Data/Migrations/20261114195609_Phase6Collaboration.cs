using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase6Collaboration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Mentions",
                table: "PageDocDerived",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Comments",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    ThreadId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    AuthorUserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Body = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    EditedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    DeletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Comments", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "CommentThreads",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BlockId = table.Column<string>(type: "char(12)", unicode: false, fixedLength: true, maxLength: 12, nullable: false),
                    AnchorStart = table.Column<byte[]>(type: "varbinary(256)", maxLength: 256, nullable: true),
                    AnchorEnd = table.Column<byte[]>(type: "varbinary(256)", maxLength: 256, nullable: true),
                    Quote = table.Column<string>(type: "nvarchar(1000)", maxLength: 1000, nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    ResolvedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ResolvedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CommentThreads", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Notifications",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Seq = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Kind = table.Column<string>(type: "varchar(20)", unicode: false, maxLength: 20, nullable: false),
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BlockId = table.Column<string>(type: "char(12)", unicode: false, fixedLength: true, maxLength: 12, nullable: true),
                    ThreadId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    CommentId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    ActorUserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Excerpt = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    DedupeKey = table.Column<string>(type: "varchar(200)", unicode: false, maxLength: 200, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notifications", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RealtimeTickets",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DeviceId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    TokenHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UsedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RealtimeTickets", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Comments_ThreadId_CreatedAt",
                table: "Comments",
                columns: new[] { "ThreadId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Comments_WorkspaceId_PageId",
                table: "Comments",
                columns: new[] { "WorkspaceId", "PageId" });

            migrationBuilder.CreateIndex(
                name: "IX_CommentThreads_WorkspaceId_PageId_CreatedAt",
                table: "CommentThreads",
                columns: new[] { "WorkspaceId", "PageId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_DedupeKey",
                table: "Notifications",
                columns: new[] { "UserId", "DedupeKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_Seq",
                table: "Notifications",
                columns: new[] { "UserId", "Seq" })
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "PageId", "ReadAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_WorkspaceId_PageId",
                table: "Notifications",
                columns: new[] { "WorkspaceId", "PageId" });

            migrationBuilder.CreateIndex(
                name: "IX_RealtimeTickets_ExpiresAt",
                table: "RealtimeTickets",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_RealtimeTickets_TokenHash",
                table: "RealtimeTickets",
                column: "TokenHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Comments");

            migrationBuilder.DropTable(
                name: "CommentThreads");

            migrationBuilder.DropTable(
                name: "Notifications");

            migrationBuilder.DropTable(
                name: "RealtimeTickets");

            migrationBuilder.DropColumn(
                name: "Mentions",
                table: "PageDocDerived");
        }
    }
}
