export async function checkIdvStatus(slackId?: string, email?: string, idvId?: string): Promise<boolean> {
  const params = new URLSearchParams();

  if (slackId) params.append('slack_id', slackId);
  if (email) params.append('email', email);
  if (idvId) params.append('idv_id', idvId);

  if (params.toString() === '') {
    return false;
  }

  try {
    const response = await fetch(`https://identity.hackclub.com/api/external/check?${params.toString()}`);

    if (!response.ok) {
      console.error('IDV check failed:', response.status);
      return false;
    }

    const data = await response.json() as { result: string };

    return data.result === 'verified_eligible';
  } catch (error) {
    console.error('IDV check error:', error);
    return false;
  }
}
