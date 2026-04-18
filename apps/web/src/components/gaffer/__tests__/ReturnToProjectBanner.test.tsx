import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ReturnToProjectBanner } from "../ReturnToProjectBanner";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe("ReturnToProjectBanner", () => {
  it("renders nothing when returnTo is absent", () => {
    const { container } = render(
      <ReturnToProjectBanner returnTo={null} returnLabel={null} contactId="c1" contactType="CLIENT" isArchived={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when contact type is TEAM_MEMBER", () => {
    const { container } = render(
      <ReturnToProjectBanner returnTo="/gaffer/projects/new" returnLabel={null} contactId="c1" contactType="TEAM_MEMBER" isArchived={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when contact is archived", () => {
    const { container } = render(
      <ReturnToProjectBanner returnTo="/gaffer/projects/new" returnLabel={null} contactId="c1" contactType="CLIENT" isArchived={true} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when returnTo does not start with /gaffer/", () => {
    const { container } = render(
      <ReturnToProjectBanner returnTo="/evil/redirect" returnLabel={null} contactId="c1" contactType="CLIENT" isArchived={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders CTA for CLIENT with valid returnTo", () => {
    render(
      <ReturnToProjectBanner returnTo="/gaffer/projects/new" returnLabel="создание проекта" contactId="c1" contactType="CLIENT" isArchived={false} />
    );
    expect(screen.getByText(/создание проекта/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /использовать как заказчика/i })).toBeInTheDocument();
  });

  it("navigates to returnTo with clientId on button click", () => {
    render(
      <ReturnToProjectBanner returnTo="/gaffer/projects/new" returnLabel={null} contactId="c42" contactType="CLIENT" isArchived={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: /использовать как заказчика/i }));
    expect(mockPush).toHaveBeenCalledWith("/gaffer/projects/new?clientId=c42");
  });
});
